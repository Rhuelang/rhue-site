//! The server over stdio, as an editor talks to it: initialize, open a
//! document, get diagnostics, hover, complete, format, shut down.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

/// A real `file://` URI for `name` in a temp folder (on Windows that has a
/// drive letter, so it can't be written out by hand)
fn file_uri(dir: &std::path::Path, name: &str) -> String {
    url::Url::from_file_path(dir.join(name))
        .expect("temp dirs are absolute")
        .to_string()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{name}-{}", std::process::id()))
}

struct Client {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl Client {
    fn start() -> Client {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rhue-lsp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Client {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn send(&mut self, msg: Value) {
        let body = msg.to_string();
        write!(self.stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Value {
        let mut len = 0;
        loop {
            let mut line = String::new();
            self.stdout.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(n) = line.strip_prefix("Content-Length: ") {
                len = n.parse().unwrap();
            }
        }
        let mut body = vec![0; len];
        self.stdout.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let msg = self.recv();
            if msg["id"] == json!(id) {
                return msg;
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// The next `publishDiagnostics` notification.
    fn diagnostics(&mut self) -> Value {
        loop {
            let msg = self.recv();
            if msg["method"] == "textDocument/publishDiagnostics" {
                return msg["params"].clone();
            }
        }
    }
}

#[test]
fn a_session() {
    let mut c = Client::start();
    let init = c.request(
        "initialize",
        json!({ "capabilities": {}, "processId": null, "rootUri": null }),
    );
    let caps = &init["result"]["capabilities"];
    assert_eq!(caps["hoverProvider"], json!(true));
    assert_eq!(caps["textDocumentSync"]["change"], json!(2));
    assert_eq!(caps["renameProvider"]["prepareProvider"], json!(true));
    assert_eq!(
        caps["signatureHelpProvider"]["triggerCharacters"],
        json!(["(", ","])
    );
    assert_eq!(
        caps["completionProvider"]["triggerCharacters"],
        json!([".", ":"])
    );
    c.notify("initialized", json!({}));

    let dir = temp_dir("rhue-lsp-protocol");
    let uri = file_uri(&dir, "main.rhue");
    let text = "--!strict\nlocal greeting = 'hi'\nlocal n: number = greeting\n";
    c.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": uri, "languageId": "rhue", "version": 1, "text": text } }),
    );
    let d = c.diagnostics();
    assert_eq!(d["uri"], uri);
    assert_eq!(
        d["diagnostics"][0]["message"],
        "Type 'string' could not be converted into 'number'"
    );
    assert_eq!(
        d["diagnostics"][0]["range"]["start"],
        json!({ "line": 2, "character": 18 })
    );

    let hover = c.request(
        "textDocument/hover",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 8 } }),
    );
    assert_eq!(
        hover["result"]["contents"]["value"],
        "```luau\ngreeting: string\n```"
    );

    // fix it, the diagnostics clear
    let fixed = "--!strict\nlocal greeting = 'hi'\nlocal n: number = #greeting\nprint(greeting)\n";
    c.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": fixed }] }),
    );
    let d = c.diagnostics();
    assert_eq!(d["diagnostics"], json!([]), "{d}");

    let def = c.request(
        "textDocument/definition",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 20 } }),
    );
    assert_eq!(
        def["result"]["range"]["start"],
        json!({ "line": 1, "character": 6 })
    );

    // mid-edit (`greeting:` doesn't parse yet), completion still works
    let typing =
        "--!strict\nlocal greeting = 'hi'\nlocal n: number = #greeting\nprint(greeting:)\n";
    c.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 3 }, "contentChanges": [{ "text": typing }] }),
    );
    c.diagnostics();
    let completion = c.request(
        "textDocument/completion",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 3, "character": 15 } }),
    );
    let labels: Vec<&str> = completion["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["label"].as_str().unwrap())
        .collect();
    assert!(
        labels.contains(&"upper") && labels.contains(&"format"),
        "{labels:?}"
    );

    c.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 4 }, "contentChanges": [{ "text": "local x=1\nif x then\nprint(x)\nend" }] }),
    );
    c.diagnostics();
    let fmt = c.request(
        "textDocument/formatting",
        json!({ "textDocument": { "uri": uri }, "options": { "tabSize": 2, "insertSpaces": true } }),
    );
    assert_eq!(
        fmt["result"][0]["newText"],
        "local x = 1\nif x then\n  print(x)\nend\n"
    );

    // rename `x` (from its use on line 2), and a refused rename
    let edit = c.request(
        "textDocument/rename",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 6 }, "newName": "flag" }),
    );
    let edits = edit["result"]["changes"][uri.as_str()].as_array().unwrap();
    assert_eq!(edits.len(), 3);
    assert!(edits.iter().all(|e| e["newText"] == "flag"));
    let refused = c.request(
        "textDocument/rename",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 1 }, "newName": "say" }),
    );
    assert_eq!(refused["error"]["code"], json!(-32803));
    let prepared = c.request(
        "textDocument/prepareRename",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 0, "character": 6 } }),
    );
    assert_eq!(
        prepared["result"]["start"],
        json!({ "line": 0, "character": 6 })
    );

    // signature help inside `print(`
    let help = c.request(
        "textDocument/signatureHelp",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 6 } }),
    );
    assert_eq!(help["result"]["signatures"][0]["label"], "print(...any)");

    // incremental edits, and a module edit republishing its dependents
    let lib = file_uri(&dir, "lib.rhue");
    let app = file_uri(&dir, "app.rhue");
    c.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": lib, "languageId": "luau", "version": 1, "text": "return { n = 1 }" } }),
    );
    c.diagnostics();
    c.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": app, "languageId": "luau", "version": 1, "text": "--!strict\nlocal lib = require('lib')\nlocal s: string = lib.n\n" } }),
    );
    let d = c.diagnostics();
    assert_eq!(d["uri"], app);
    assert_eq!(d["diagnostics"].as_array().unwrap().len(), 1);
    c.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": lib, "version": 2 }, "contentChanges": [
            { "range": { "start": { "line": 0, "character": 13 }, "end": { "line": 0, "character": 14 } }, "text": "'a'" }
        ] }),
    );
    let first = c.diagnostics();
    assert_eq!(first["uri"], lib);
    let second = c.diagnostics();
    assert_eq!(second["uri"], app);
    assert_eq!(second["diagnostics"], json!([]));

    let unknown = c.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": uri } }),
    );
    assert_eq!(unknown["error"]["code"], json!(-32601));

    let shutdown = c.request("shutdown", Value::Null);
    assert_eq!(shutdown["result"], Value::Null);
    c.notify("exit", Value::Null);
    assert!(c.child.wait().unwrap().success());
}

#[test]
fn editor_features_over_the_wire() {
    let dir = std::env::temp_dir().join(format!("rhue-lsp-protocol-m17-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("lib.rhue"),
        "--!strict\nlocal M = {}\nfunction M.greet(name: string) return 'hi ' .. name end\nreturn M\n",
    )
    .unwrap();
    let root = url::Url::from_directory_path(&dir)
        .expect("temp dirs are absolute")
        .to_string();
    let mut c = Client::start();
    let init = c.request(
        "initialize",
        json!({ "capabilities": {}, "processId": null, "rootUri": root }),
    );
    let caps = &init["result"]["capabilities"];
    assert_eq!(caps["inlayHintProvider"], json!(true));
    assert_eq!(caps["documentSymbolProvider"], json!(true));
    assert_eq!(caps["workspaceSymbolProvider"], json!(true));
    assert_eq!(caps["semanticTokensProvider"]["full"], json!(true));
    assert_eq!(
        caps["semanticTokensProvider"]["legend"]["tokenTypes"][0],
        json!("keyword")
    );
    assert_eq!(
        caps["codeActionProvider"]["codeActionKinds"],
        json!(["quickfix", "refactor.rewrite"])
    );
    c.notify("initialized", json!({}));

    let uri = file_uri(&dir, "main.rhue");
    let text = "--!strict\nlocal lib = require('lib')\nlocal s = lib.greet('a')\nprint(s.lenn)\n";
    c.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": uri, "languageId": "rhue", "version": 1, "text": text } }),
    );
    let d = c.diagnostics();
    assert_eq!(d["diagnostics"].as_array().unwrap().len(), 1, "{d}");

    let doc = json!({ "uri": uri });
    let whole =
        json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 4, "character": 0 } });
    let hints = c.request(
        "textDocument/inlayHint",
        json!({ "textDocument": doc, "range": whole }),
    );
    let labels: Vec<&str> = hints["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["label"].as_str().unwrap())
        .collect();
    assert!(labels.contains(&": string"), "{hints}");

    let actions = c.request(
        "textDocument/codeAction",
        json!({ "textDocument": doc, "range": { "start": { "line": 3, "character": 8 }, "end": { "line": 3, "character": 12 } }, "context": { "diagnostics": [] } }),
    );
    assert_eq!(
        actions["result"][0]["title"], "Change to 'len'",
        "{actions}"
    );
    assert_eq!(actions["result"][0]["kind"], "quickfix");
    let edit = &actions["result"][0]["edit"]["changes"][&uri][0];
    assert_eq!(edit["newText"], "len");

    let symbols = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": doc }),
    );
    assert_eq!(symbols["result"][0]["name"], "lib", "{symbols}");
    let ws = c.request("workspace/symbol", json!({ "query": "greet" }));
    assert_eq!(ws["result"][0]["name"], "greet", "{ws}");
    assert_eq!(ws["result"][0]["containerName"], "M");
    assert!(
        ws["result"][0]["location"]["uri"]
            .as_str()
            .unwrap()
            .ends_with("lib.rhue")
    );

    let tokens = c.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": doc }),
    );
    let data = tokens["result"]["data"].as_array().unwrap();
    assert_eq!(data.len() % 5, 0);
    // the first token: `local` (keyword) on line 1 (the directive is a comment)
    assert_eq!(
        &data[..5],
        &[json!(1), json!(0), json!(5), json!(0), json!(0)]
    );

    let def = c.request(
        "textDocument/definition",
        json!({ "textDocument": doc, "position": { "line": 2, "character": 15 } }),
    );
    assert!(
        def["result"]["uri"].as_str().unwrap().ends_with("lib.rhue"),
        "{def}"
    );
    assert_eq!(
        def["result"]["range"]["start"],
        json!({ "line": 2, "character": 11 })
    );

    let shutdown = c.request("shutdown", Value::Null);
    assert_eq!(shutdown["result"], Value::Null);
    c.notify("exit", Value::Null);
    assert!(c.child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(dir);
}
