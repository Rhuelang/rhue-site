//! The language server's answers, on plain strings (positions are found by
//! a `|` marker in the source, which is removed).

use lsp_types::{CompletionItemKind, HoverContents, Position, Range, Uri};
use rhue_lsp::{Docs, LineIndex};

fn uri() -> Uri {
    rhue_lsp::uri::from_file_path(std::env::temp_dir().join("rhue-lsp-test/main.rhue")).unwrap()
}

/// The source without its `|`, and the position of the `|`.
fn at(marked: &str) -> (String, Position) {
    let i = marked.find('|').expect("a | marker");
    let text = marked.replacen('|', "", 1);
    let pos = LineIndex::new(&text).position(i);
    (text, pos)
}

fn hover(marked: &str) -> Option<String> {
    let (text, pos) = at(marked);
    let h = rhue_lsp::hover(&Docs::default(), &uri(), &text, pos)?;
    match h.contents {
        HoverContents::Markup(m) => Some(
            m.value
                .trim_start_matches("```luau\n")
                .trim_end_matches("\n```")
                .to_string(),
        ),
        _ => None,
    }
}

fn completions(marked: &str) -> Vec<(String, Option<CompletionItemKind>, Option<String>)> {
    let (text, pos) = at(marked);
    rhue_lsp::completion(&Docs::default(), &uri(), &text, pos)
        .into_iter()
        .map(|c| (c.label, c.kind, c.detail))
        .collect()
}

fn labels(marked: &str) -> Vec<String> {
    completions(marked).into_iter().map(|c| c.0).collect()
}

#[test]
fn line_index_speaks_utf16() {
    let text = "a😀b\nhé\n";
    let idx = LineIndex::new(text);
    assert_eq!(idx.position(0), Position::new(0, 0));
    assert_eq!(idx.position(5), Position::new(0, 3)); // after the emoji: 2 UTF-16 units
    assert_eq!(idx.offset(Position::new(0, 3)), 5);
    assert_eq!(
        idx.position(text.find('é').unwrap() + 2),
        Position::new(1, 2)
    );
    assert_eq!(
        idx.offset(Position::new(1, 99)),
        text.find("\n\n").unwrap_or(text.len() - 1)
    );
    assert_eq!(idx.offset(Position::new(9, 0)), text.len());
}

#[test]
fn diagnostics_follow_the_directive() {
    let docs = Docs::default();
    let strict = "--!strict\nlocal x: number = 'a'\nlocal y = nope";
    let d = rhue_lsp::diagnostics(&docs, &uri(), strict);
    let msgs: Vec<&str> = d.iter().map(|d| d.message.as_str()).collect();
    assert_eq!(
        msgs,
        [
            "Type '\"a\"' could not be converted into 'number'",
            "Unknown global 'nope'"
        ]
    );
    assert_eq!(d[0].range.start, Position::new(1, 18));
    // without a directive files are checked non-strictly: annotations count
    let loose = "local x: number = 'a'\nlocal y = nope";
    let d = rhue_lsp::diagnostics(&docs, &uri(), loose);
    assert_eq!(d.len(), 1);
    let syntax = rhue_lsp::diagnostics(&docs, &uri(), "local = 1");
    assert!(syntax[0].message.contains("expected"), "{:?}", syntax);
    assert!(rhue_lsp::diagnostics(&docs, &uri(), "--!nocheck\nlocal x: number = 'a'").is_empty());
}

#[test]
fn hover_shows_types() {
    let src = "--!strict\nlocal function add(a: number, b: number) return a + b end\nlocal to|tal = add(1, 2)";
    assert_eq!(hover(src).as_deref(), Some("total: number"));
    assert_eq!(
        hover("--!strict\nlocal function add(a: number, b: number) return a + b end\nlocal t = ad|d(1, 2)").as_deref(),
        Some("add: (number, number) -> number")
    );
    assert_eq!(
        hover("local p = { x = 1, name = 'a' }\nprint(p.na|me)").as_deref(),
        Some("string")
    );
    // even unchecked files get (lenient) types
    assert_eq!(
        hover("--!nocheck\nlocal s = ('x'):up|per()").as_deref(),
        Some("string")
    );
    assert_eq!(hover("local s = 1\n  |\nprint(s)"), None);
}

#[test]
fn definitions_and_references() {
    let docs = Docs::default();
    let src = "local count = 0\nlocal function bump()\n\tcount += 1\n\treturn count\nend\nprint(co|unt, bump())";
    let (text, pos) = at(src);
    let def = rhue_lsp::definition(&docs, &uri(), &text, pos).unwrap();
    assert_eq!(def.range.start, Position::new(0, 6));
    let refs = rhue_lsp::references(&docs, &uri(), &text, pos);
    let lines: Vec<u32> = refs.iter().map(|l| l.range.start.line).collect();
    assert_eq!(lines, [0, 2, 3, 5]);
    // shadowing: the inner `x` is a different local
    let src = "local x = 1\ndo\n\tlocal x = 2\n\tprint(|x)\nend";
    let (text, pos) = at(src);
    let def = rhue_lsp::definition(&docs, &uri(), &text, pos).unwrap();
    assert_eq!(def.range.start, Position::new(2, 7));
}

#[test]
fn definition_of_a_required_module() {
    let dir = std::env::temp_dir().join(format!("rhue-lsp-mod-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("util")).unwrap();
    std::fs::write(
        dir.join("util/strings.rhue"),
        "--!strict\nreturn { shout = function(s: string) return s:upper() end }",
    )
    .unwrap();
    let main = rhue_lsp::uri::from_file_path(dir.join("main.rhue")).unwrap();
    let (text, pos) =
        at("--!strict\nlocal S = require('util.str|ings')\nlocal n: number = S.shout('x')");
    let docs = Docs::default();
    let def = rhue_lsp::definition(&docs, &main, &text, pos).unwrap();
    assert!(
        def.uri.as_str().ends_with("util/strings.rhue"),
        "{}",
        def.uri.as_str()
    );
    // the module's types reach the requiring file
    let d = rhue_lsp::diagnostics(&docs, &main, &text);
    assert_eq!(d.len(), 1);
    assert_eq!(
        d[0].message,
        "Type 'string' could not be converted into 'number'"
    );
    // an open (unsaved) version of the module wins over the file on disk
    let mut docs = Docs::default();
    let module = rhue_lsp::uri::from_file_path(dir.join("util/strings.rhue")).unwrap();
    docs.open.insert(
        module,
        "--!strict\nreturn { shout = function(s: string): number return #s end }".into(),
    );
    assert!(rhue_lsp::diagnostics(&docs, &main, &text).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn member_completion() {
    let src = "--!strict\nlocal p = { x = 1, name = 'a', greet = function() end }\np.|";
    let got = completions(src);
    assert!(
        got.contains(&(
            "x".into(),
            Some(CompletionItemKind::FIELD),
            Some("number".into())
        )),
        "{got:?}"
    );
    assert!(
        got.iter()
            .any(|c| c.0 == "greet" && c.1 == Some(CompletionItemKind::FUNCTION))
    );
    // methods through a class's metatable, after `:` (only functions)
    let class = "--!strict
local Account = {}
Account.__index = Account
function Account.new(b: number) return setmetatable({ balance = b }, Account) end
function Account:deposit(n: number) self.balance += n end
local a = Account.new(1)
a:de|";
    let got = labels(class);
    assert!(got.contains(&"deposit".to_string()), "{got:?}");
    assert!(!got.contains(&"balance".to_string()), "{got:?}");
    let got = labels(&class.replace("a:de|", "a.|"));
    assert!(
        got.contains(&"balance".to_string()) && got.contains(&"deposit".to_string()),
        "{got:?}"
    );
    // strings complete to the string library
    let got = labels("local s = 'x'\ns:|");
    assert!(
        got.contains(&"upper".to_string()) && got.contains(&"gsub".to_string()),
        "{got:?}"
    );
    // library tables
    let got = labels("string.|");
    assert!(got.contains(&"format".to_string()), "{got:?}");
}

#[test]
fn name_completion() {
    let got =
        completions("local alpha = 1\nlocal function beta() end\nlocal x = |\nlocal gamma = 2");
    let names: Vec<&str> = got.iter().map(|c| c.0.as_str()).collect();
    assert!(
        names.contains(&"alpha") && names.contains(&"beta"),
        "{names:?}"
    );
    assert!(!names.contains(&"gamma"), "declared later: {names:?}");
    assert!(
        names.contains(&"print") && names.contains(&"coroutine"),
        "{names:?}"
    );
    assert!(
        names.contains(&"function") && names.contains(&"local"),
        "{names:?}"
    );
    let beta = got.iter().find(|c| c.0 == "beta").unwrap();
    assert_eq!(beta.1, Some(CompletionItemKind::FUNCTION));
}

#[test]
fn formatting_edits() {
    let edits = rhue_lsp::formatting("local x=1\nif x then\nprint(x)\nend", false, 4).unwrap();
    assert_eq!(edits.len(), 1);
    assert_eq!(
        edits[0].new_text,
        "local x = 1\nif x then\n\tprint(x)\nend\n"
    );
    let edits = rhue_lsp::formatting("do\nx()\nend\n", true, 2).unwrap();
    assert_eq!(edits[0].new_text, "do\n  x()\nend\n");
    assert_eq!(rhue_lsp::formatting("x = 1\n", false, 4).unwrap(), []);
    assert!(rhue_lsp::formatting("local = 1", false, 4).is_none());
}

fn rename(marked: &str, new_name: &str) -> Result<String, String> {
    let (text, pos) = at(marked);
    let edit = rhue_lsp::rename(&Docs::default(), &uri(), &text, pos, new_name)?;
    let mut edits = edit.changes.unwrap().remove(&uri()).unwrap();
    let idx = LineIndex::new(&text);
    edits.sort_by_key(|e| std::cmp::Reverse((e.range.start.line, e.range.start.character)));
    let mut out = text.clone();
    for e in edits {
        let (s, t) = (idx.offset(e.range.start), idx.offset(e.range.end));
        out.replace_range(s..t, &e.new_text);
    }
    Ok(out)
}

#[test]
fn rename_changes_a_local_everywhere() {
    let src = "local count = 0\nlocal function bump()\n  count += 1\n  return `n={count}`\nend\nprint(co|unt)\n";
    assert_eq!(
        rename(src, "total").unwrap(),
        "local total = 0\nlocal function bump()\n  total += 1\n  return `n={total}`\nend\nprint(total)\n"
    );
    // from the declaration too, and only that variable (not a shadowing one)
    let src = "local |x = 1\ndo\n  local x = 2\n  print(x)\nend\nprint(x)\n";
    assert_eq!(
        rename(src, "y").unwrap(),
        "local y = 1\ndo\n  local x = 2\n  print(x)\nend\nprint(y)\n"
    );
    // parameters and functions
    let src = "local function add(a, b) return a + b end\nprint(ad|d(1, 2))\n";
    assert_eq!(
        rename(src, "plus").unwrap(),
        "local function plus(a, b) return a + b end\nprint(plus(1, 2))\n"
    );
    let (text, pos) = at("local |n = 1\n");
    assert!(rhue_lsp::prepare_rename(&Docs::default(), &uri(), &text, pos).is_some());
}

#[test]
fn rename_refuses_what_it_cant_do_safely() {
    let err = |src: &str, name: &str| rename(src, name).unwrap_err();
    assert!(err("pri|nt(1)\n", "say").contains("only locals"));
    assert!(err("local t = {}\nt.fi|eld = 1\n", "f").contains("only locals"));
    assert!(err("local |a = 1\n", "end").contains("isn't a valid name"));
    assert!(err("local |a = 1\n", "2x").contains("isn't a valid name"));
    // `b` inside the block would start meaning the renamed `a`
    assert!(
        err("local b = 1\nlocal |a = 2\nprint(a, b)\n", "b").contains("change what another name")
    );
    // a global used in the scope would be captured
    assert!(
        err("local |a = 2\nprint(a, tostring)\n", "tostring").contains("change what another name")
    );
    let (text, pos) = at("pri|nt(1)\n");
    assert!(rhue_lsp::prepare_rename(&Docs::default(), &uri(), &text, pos).is_none());
}

fn signature(marked: &str) -> Option<(String, Vec<String>, u32)> {
    let (text, pos) = at(marked);
    let help = rhue_lsp::signature_help(&Docs::default(), &uri(), &text, pos)?;
    let sig = &help.signatures[0];
    let utf16: Vec<u16> = sig.label.encode_utf16().collect();
    let params = sig
        .parameters
        .as_ref()
        .unwrap()
        .iter()
        .map(|p| match p.label {
            lsp_types::ParameterLabel::LabelOffsets([s, e]) => {
                String::from_utf16(&utf16[s as usize..e as usize]).unwrap()
            }
            _ => unreachable!(),
        })
        .collect();
    Some((sig.label.clone(), params, help.active_parameter.unwrap()))
}

#[test]
fn signature_help_for_the_call_at_the_cursor() {
    let defs = "local function add(a: number, b: string): number return a end\n";
    let s = signature(&format!("{defs}add(1, |)")).unwrap();
    assert_eq!(s.0, "add(a: number, b: string) -> number");
    assert_eq!(s.1, ["a: number", "b: string"]);
    assert_eq!(s.2, 1);
    // while typing, before the call parses
    assert_eq!(signature(&format!("{defs}add(|")).unwrap().2, 0);
    assert_eq!(
        signature(&format!("{defs}local x = add(1, |\nprint(x)"))
            .unwrap()
            .2,
        1
    );
    // commas in nested calls, tables and strings don't count
    let s = signature(&format!(
        "{defs}add(math.max(1, 2), {{ 1, 2 }}, \"a, b\", |"
    ))
    .unwrap();
    assert_eq!(s.2, 3);
    // library functions (no names to show) and methods (no `self`)
    let s = signature("string.rep(\"a\", |)").unwrap();
    assert_eq!(s.0, "string.rep(string, number) -> string");
    assert_eq!(s.2, 1);
    let s = signature("local s = \"x\"\ns:rep(|)").unwrap();
    assert_eq!(s.1, ["number"]);
    let obj = "local obj = { n = 1 }\nfunction obj:get(key: string, default: number?) return self.n end\n";
    let s = signature(&format!("{obj}obj:get(\"k\", |)")).unwrap();
    assert_eq!(s.0, "obj:get(key: string, default: number?) -> number");
    assert_eq!(s.2, 1);
    // variadics keep highlighting the last parameter
    let s = signature("print(1, 2, 3|)").unwrap();
    assert_eq!(s.0, "print(...any)");
    assert_eq!(s.2, 0);
    // not in a call, or inside a string in one
    assert!(signature("local x = 1|").is_none());
    assert!(signature(&format!("{defs}add(\"(|\")")).is_none_or(|s| s.0.starts_with("add")));
    assert!(signature("-- print(|\n").is_none());
}

#[test]
fn incremental_edits_apply_by_utf16_range() {
    let mut docs = Docs::default();
    let u = uri();
    docs.set_text(&u, "local s = \"héllo 😀\"\nprint(s)\n".into());
    // replace `print` (line 1, columns 0..5) with `warn`, then insert after the
    // emoji (a surrogate pair: two UTF-16 units)
    docs.apply_change(
        &u,
        Some(Range::new(Position::new(1, 0), Position::new(1, 5))),
        "warn",
    );
    docs.apply_change(
        &u,
        Some(Range::new(Position::new(0, 18), Position::new(0, 18))),
        "!",
    );
    assert_eq!(docs.open[&u], "local s = \"héllo 😀!\"\nwarn(s)\n");
    // no range: the whole text
    docs.apply_change(&u, None, "return 1");
    assert_eq!(docs.open[&u], "return 1");
}

#[test]
fn requests_share_an_analysis_and_imports_are_checked_once() {
    let dir = std::env::temp_dir().join(format!("rhue-lsp-incr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("util.rhue"),
        "--!strict\nreturn { twice = function(n: number): number return n * 2 end }",
    )
    .unwrap();
    let main = rhue_lsp::uri::from_file_path(dir.join("main.rhue")).unwrap();
    let other = rhue_lsp::uri::from_file_path(dir.join("other.rhue")).unwrap();
    let util = rhue_lsp::uri::from_file_path(dir.join("util.rhue")).unwrap();
    let mut docs = Docs::default();
    docs.set_text(
        &main,
        "--!strict\nlocal util = require('util')\nlocal x: number = util.twice(2)\n".into(),
    );
    docs.set_text(&other, "print(1)\n".into());
    let stats = |d: &Docs| (d.stats().analyses.get(), d.stats().module_loads.get());

    let text = docs.open[&main].clone();
    assert!(rhue_lsp::diagnostics(&docs, &main, &text).is_empty());
    let (a0, m0) = stats(&docs);
    assert_eq!((a0, m0), (1, 1));
    // hover, definition and references after the same keystroke reuse it
    let pos = Position::new(2, 7);
    rhue_lsp::hover(&docs, &main, &text, pos).unwrap();
    rhue_lsp::definition(&docs, &main, &text, pos);
    rhue_lsp::references(&docs, &main, &text, pos);
    assert_eq!(stats(&docs), (1, 1));

    // typing in main re-analyzes main, but not `util`
    let others = docs.apply_change(
        &main,
        Some(Range::new(Position::new(2, 6), Position::new(2, 7))),
        "y",
    );
    assert!(others.is_empty());
    let text = docs.open[&main].clone();
    assert!(rhue_lsp::diagnostics(&docs, &main, &text).is_empty());
    assert_eq!(stats(&docs), (2, 1));

    // opening util with a different type: main depends on it, other doesn't
    rhue_lsp::diagnostics(&docs, &other, "print(1)\n");
    let affected = docs.set_text(
        &util,
        "--!strict\nreturn { twice = function(n: number): string return 'x' end }".into(),
    );
    assert_eq!(affected, std::slice::from_ref(&main));
    let d = rhue_lsp::diagnostics(&docs, &main, &text);
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(stats(&docs).1, 2);
    // `other` kept its analysis
    let before = stats(&docs).0;
    rhue_lsp::diagnostics(&docs, &other, "print(1)\n");
    assert_eq!(stats(&docs).0, before);

    // closing util goes back to the file on disk
    assert_eq!(docs.close(&util), std::slice::from_ref(&main));
    assert!(rhue_lsp::diagnostics(&docs, &main, &text).is_empty());
    // a file changing on disk affects documents that read modules
    std::fs::write(dir.join("util.rhue"), "return 5").unwrap();
    assert_eq!(docs.files_changed(), std::slice::from_ref(&main));
    assert_eq!(rhue_lsp::diagnostics(&docs, &main, &text).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
