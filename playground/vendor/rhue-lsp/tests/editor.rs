//! Milestone 17's editor features on plain strings and real files: inlay
//! hints, code actions, symbols, semantic tokens, and definitions and
//! references across modules.

use std::path::PathBuf;

use lsp_types::{
    CodeActionOrCommand, DocumentSymbol, InlayHintLabel, Location, Position, Range, SymbolKind, Uri,
};
use rhue_lsp::uri::UriExt;
use rhue_lsp::{Docs, LineIndex};

/// A fresh folder for one test's files.
fn workspace(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rhue-lsp-m17-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let p = dir.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    dir
}

fn uri(path: &std::path::Path) -> Uri {
    rhue_lsp::uri::from_file_path(path).unwrap()
}

fn whole(text: &str) -> Range {
    let idx = LineIndex::new(text);
    Range::new(Position::new(0, 0), idx.position(text.len()))
}

/// The position of the `n`th (from 0) occurrence of `needle`, plus `skip`.
fn pos_of(text: &str, needle: &str, n: usize, skip: usize) -> Position {
    let at = text.match_indices(needle).nth(n).expect("needle").0 + skip;
    LineIndex::new(text).position(at)
}

/// What a location points at, as `file:text`.
fn at(loc: &Location) -> String {
    let path = loc.uri.to_file_path().unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    let idx = LineIndex::new(&text);
    let (s, e) = (idx.offset(loc.range.start), idx.offset(loc.range.end));
    format!(
        "{}:{}",
        path.file_name().unwrap().to_string_lossy(),
        &text[s..e]
    )
}

// ─ Inlay Hints ───────────────────────────────────────────────────────────────

fn hints(text: &str) -> Vec<(String, String, bool)> {
    let u = uri(&std::env::temp_dir().join("rhue-m17-hints.rhue"));
    let idx = LineIndex::new(text);
    rhue_lsp::inlay_hints(&Docs::default(), &u, text, whole(text))
        .into_iter()
        .map(|h| {
            let at = idx.offset(h.position);
            let before: String = if text[..at].ends_with(')') {
                ")".into()
            } else {
                let word = text[..at]
                    .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .map_or(0, |i| i + 1);
                text[word..at].to_string()
            };
            let label = match h.label {
                InlayHintLabel::String(s) => s,
                InlayHintLabel::LabelParts(_) => panic!("parts"),
            };
            (before, label, h.text_edits.is_some())
        })
        .collect()
}

#[test]
fn inlay_hints_show_inferred_types() {
    let src = "--!strict
local xs = { 3, 1, 2 }
table.sort(xs, function(a, b) return a < b end)
local function total(items: {number})
  local sum = 0
  for _, v in items do sum += v end
  return sum
end
local best
for _, v in xs do if v > 1 then best = v end end
local t = total(xs)
";
    let h = hints(src);
    let has = |name: &str, label: &str| h.iter().any(|(b, l, _)| b == name && l == label);
    assert!(has("xs", ": {number}"), "{h:?}");
    assert!(has("a", ": number") && has("b", ": number"), "{h:?}");
    assert!(has(")", ": boolean"), "callback result: {h:?}");
    assert!(has(")", ": number"), "total's result: {h:?}");
    assert!(has("v", ": number"), "{h:?}");
    assert!(has("best", ": number?"), "a flow local's final type: {h:?}");
    assert!(has("t", ": number"), "{h:?}");
    // not for what's obvious, written, or thrown away
    assert!(
        !h.iter()
            .any(|(b, _, _)| b == "sum" || b == "items" || b == "_"),
        "{h:?}"
    );
    assert!(h.iter().all(|(_, _, insertable)| *insertable));
}

#[test]
fn hints_that_cant_be_written_arent_insertable() {
    let src = "--!strict
local V = {}
V.__index = V
function V.new() return setmetatable({ x = 1 }, V) end
local v = V.new()
";
    let h = hints(src);
    let v = h.iter().find(|(b, _, _)| b == "v").expect("a hint for v");
    assert!(v.1.contains("metatable"), "{h:?}");
    assert!(!v.2, "a type with a metatable has no syntax: {h:?}");
}

// ─ Code Actions ──────────────────────────────────────────────────────────────

/// Code actions for the range of the `n`th `needle`, with the text each
/// would produce.
fn actions(text: &str, needle: &str) -> Vec<(String, String)> {
    let u = uri(&std::env::temp_dir().join("rhue-m17-actions.rhue"));
    let start = text.find(needle).expect("needle");
    let idx = LineIndex::new(text);
    let range = Range::new(idx.position(start), idx.position(start + needle.len()));
    rhue_lsp::code_actions(&Docs::default(), &u, text, range)
        .into_iter()
        .map(|a| {
            let CodeActionOrCommand::CodeAction(a) = a else {
                panic!("a command")
            };
            let mut edits = a.edit.unwrap().changes.unwrap().remove(&u).unwrap();
            edits.sort_by_key(|e| std::cmp::Reverse((e.range.start.line, e.range.start.character)));
            let mut out = text.to_string();
            for e in edits {
                let (s, t) = (idx.offset(e.range.start), idx.offset(e.range.end));
                out.replace_range(s..t, &e.new_text);
            }
            (a.title, out)
        })
        .collect()
}

#[test]
fn quick_fixes_for_misspellings() {
    let src = "--!strict\nlocal p = { name = 'a', age = 3 }\nprint(p.nmae)\n";
    let a = actions(src, "nmae");
    assert_eq!(a[0].0, "Change to 'name'");
    assert!(a[0].1.contains("print(p.name)"), "{a:?}");

    let src = "--!strict\npirnt('hi')\n";
    let a = actions(src, "pirnt");
    assert_eq!(a[0].0, "Change to 'print'");
    assert!(a[0].1.starts_with("--!strict\nprint('hi')"));

    let src = "--!strict\nlocal s = 'abc'\nprint(s:uppr())\n";
    let a = actions(src, "uppr");
    assert!(a[0].1.contains("s:upper()"), "{a:?}");

    // methods of a class, through its metatable
    let src = "--!strict
local C = {}
C.__index = C
function C.new() return setmetatable({ n = 0 }, C) end
function C:increment() self.n += 1 end
C.new():incremnet()
";
    let a = actions(src, "incremnet");
    assert!(a[0].1.contains("C.new():increment()"), "{a:?}");

    // nothing close: no fix
    let src = "--!strict\nlocal p = { name = 'a' }\nprint(p.zzzzz)\n";
    assert!(actions(src, "zzzzz").is_empty());
}

#[test]
fn quick_fix_asserts_against_nil() {
    let src = "--!strict
local function find(): { v: number }? return nil end
local n: number = find().v
";
    let a = actions(src, "find().v");
    let (title, fixed) = &a[0];
    assert_eq!(title, "Assert that it isn't nil");
    assert!(
        fixed.contains("local n: number = assert(find()).v"),
        "{fixed}"
    );
    // the fix works: `assert` returns its argument without the nil
    let check = rhue::Engine::new().check("t.rhue", fixed);
    assert!(check.is_ok(), "{:?}", check.err().map(|e| e.render(false)));
}

#[test]
fn actions_write_in_inferred_types() {
    let src = "--!strict\nlocal xs = { 1, 2 }\nlocal function count() return #xs end\n";
    let a = actions(src, "xs = ");
    assert_eq!(a[0].0, "Add type annotation `{number}`");
    assert!(a[0].1.contains("local xs: {number} = { 1, 2 }"));
    let a = actions(src, "count");
    assert_eq!(a[0].0, "Add return type annotation `number`");
    assert!(
        a[0].1
            .contains("local function count(): number return #xs end")
    );
    // each written type checks
    for (_, fixed) in actions(src, src.trim()) {
        assert!(
            rhue::Engine::new().check("t.rhue", &fixed).is_ok(),
            "{fixed}"
        );
    }
}

// ─ Symbols ───────────────────────────────────────────────────────────────────

fn tree(symbols: &[DocumentSymbol], depth: usize, out: &mut Vec<String>) {
    for s in symbols {
        let detail = s
            .detail
            .as_deref()
            .map(|d| format!(" : {d}"))
            .unwrap_or_default();
        out.push(format!(
            "{}{:?} {}{detail}",
            "  ".repeat(depth),
            s.kind,
            s.name
        ));
        tree(s.children.as_deref().unwrap_or_default(), depth + 1, out);
    }
}

const COUNTER: &str = "--!strict
type Options = { start: number }
local Counter = { step = 1 }
Counter.__index = Counter
function Counter.new(opts: Options)
  local function clamp(n: number) return math.max(n, 0) end
  return setmetatable({ n = clamp(opts.start) }, Counter)
end
function Counter:bump()
  self.n += self.step
end
Counter.limit = 10
return Counter
";

#[test]
fn document_symbols_nest() {
    let u = uri(&std::env::temp_dir().join("rhue-m17-symbols.rhue"));
    let symbols = rhue_lsp::document_symbols(&Docs::default(), &u, COUNTER);
    let mut out = Vec::new();
    tree(&symbols, 0, &mut out);
    let s = out.join("\n");
    assert!(
        s.starts_with("Interface Options\nVariable Counter : "),
        "{s}"
    );
    for line in [
        "  Field step",
        "  Method new : (Options) -> ",
        "    Function clamp : (number) -> number",
        "  Method bump",
        "  Field limit",
    ] {
        assert!(s.contains(line), "{line} in\n{s}");
    }
    // ranges hold their names
    fn check(s: &[DocumentSymbol]) {
        for x in s {
            assert!(
                x.range.start <= x.selection_range.start && x.selection_range.end <= x.range.end
            );
            check(x.children.as_deref().unwrap_or_default());
        }
    }
    check(&symbols);
}

#[test]
fn workspace_symbols_search_every_file() {
    let dir = workspace(
        "ws",
        &[
            ("counter.rhue", COUNTER),
            (
                "lib/shapes.rhue",
                "local function newRing() end\nreturn { newRing = newRing }\n",
            ),
            ("target/ignored.rhue", "local function newThing() end\n"),
            (".hidden/ignored.rhue", "local function newHidden() end\n"),
        ],
    );
    let mut docs = Docs::default();
    docs.roots = vec![dir.clone()];
    let found = rhue_lsp::workspace_symbols(&docs, "new");
    let names: Vec<(String, Option<String>, SymbolKind)> = found
        .iter()
        .map(|s| (s.name.clone(), s.container_name.clone(), s.kind))
        .collect();
    assert!(
        names.contains(&("new".into(), Some("Counter".into()), SymbolKind::METHOD)),
        "{names:?}"
    );
    assert!(
        names.contains(&("newRing".into(), None, SymbolKind::FUNCTION)),
        "{names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|n| n.0 == "newThing" || n.0 == "newHidden"),
        "{names:?}"
    );
    // fuzzy: in order, any case
    let found = rhue_lsp::workspace_symbols(&docs, "nwrg");
    assert_eq!(found.len(), 1);
    assert_eq!(at(&found[0].location), "shapes.rhue:newRing");
    // a file open in the editor counts with its unsaved text
    let open = uri(&dir.join("counter.rhue"));
    docs.set_text(&open, "local function brandNew() end\n".into());
    assert!(rhue_lsp::workspace_symbols(&docs, "brandNew").len() == 1);
    assert!(rhue_lsp::workspace_symbols(&docs, "bump").is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

// ─ Semantic Tokens ───────────────────────────────────────────────────────────

/// The tokens decoded back into (text, type, modifiers).
fn tokens(text: &str) -> Vec<(String, String, Vec<String>)> {
    let t = rhue_lsp::semantic_tokens(text);
    let lines: Vec<&str> = text.split('\n').collect();
    let (mut line, mut col) = (0u32, 0u32);
    t.data
        .iter()
        .map(|d| {
            if d.delta_line > 0 {
                line += d.delta_line;
                col = d.delta_start;
            } else {
                col += d.delta_start;
            }
            let units: Vec<u16> = lines[line as usize].encode_utf16().collect();
            let word = String::from_utf16(&units[col as usize..(col + d.length) as usize]).unwrap();
            let ty = rhue_lsp::LEGEND_TYPES[d.token_type as usize]
                .as_str()
                .to_string();
            let mods = rhue_lsp::LEGEND_MODIFIERS
                .iter()
                .enumerate()
                .filter(|(i, _)| d.token_modifiers_bitset & (1 << i) != 0)
                .map(|(_, m)| m.as_str().to_string())
                .collect();
            (word, ty, mods)
        })
        .collect()
}

#[test]
fn semantic_tokens_know_what_names_are() {
    let src = "local m = require('m')
type Box<T> = { read value: T }
local function wrap<T>(x: T, n): Box<T>
  local e = \"é\" .. `{n} and \"{x}\"`
  print(m.size, #e)
  return { value = x }
end
--[[ a
comment ]]
local s = [[two
lines]]
";
    let t = tokens(src);
    let find = |w: &str| {
        t.iter()
            .filter(|(word, _, _)| word == w)
            .map(|(_, ty, mods)| {
                format!(
                    "{ty}{}",
                    mods.iter().map(|m| format!("+{m}")).collect::<String>()
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(find("m"), ["namespace+declaration", "namespace"]);
    assert_eq!(find("require"), ["function+defaultLibrary"]);
    assert_eq!(find("Box"), ["type+declaration", "type"]);
    assert_eq!(
        find("T"),
        [
            "typeParameter+declaration",
            "typeParameter",
            "typeParameter+declaration",
            "typeParameter",
            "typeParameter"
        ]
    );
    assert_eq!(find("read"), ["keyword"]);
    assert_eq!(
        find("value"),
        ["property+declaration", "property+declaration"]
    );
    assert_eq!(find("wrap"), ["function+declaration"]);
    assert_eq!(
        find("x"),
        ["parameter+declaration", "parameter", "parameter"]
    );
    assert_eq!(find("n"), ["parameter+declaration", "parameter"]);
    assert_eq!(find("e"), ["variable+declaration", "variable"]);
    assert_eq!(find("\"é\""), ["string"]);
    assert_eq!(find("print"), ["function+defaultLibrary"]);
    assert_eq!(find("size"), ["property"]);
    assert_eq!(find("type"), ["keyword"]);
    // interpolation: the text around the holes is string, the holes aren't
    assert_eq!(find("`{"), ["string"]);
    assert_eq!(find("} and \"{"), ["string"]);
    assert_eq!(find("}\"`"), ["string"]);
    // a long string is split per line, comments are left to the grammar
    assert_eq!(find("[[two"), ["string"]);
    assert_eq!(find("lines]]"), ["string"]);
    assert!(find("comment ]]").is_empty());
    // a file that doesn't parse still gets keywords and literals
    let t = tokens("local x = (1 +\nprint('a')");
    assert!(t.iter().any(|(w, ty, _)| w == "local" && ty == "keyword"));
    assert!(t.iter().any(|(w, ty, _)| w == "'a'" && ty == "string"));
}

// ─ Across Modules ────────────────────────────────────────────────────────────

const SHAPES: &str = "local M = {}
function M.area(w: number, h: number) return w * h end
M.unit = 1
local function perimeter(w: number, h: number) return 2 * (w + h) end
M.perimeter = perimeter
function M.square(s: number) return M.area(s, s) end
return M
";

const MAIN: &str = "local shapes = require('geo.shapes')
local a = shapes.area(2, 3)
local u = require('geo.shapes').unit
print(shapes.perimeter(1, 1), shapes.area(1, 1))
";

#[test]
fn definitions_cross_modules() {
    let dir = workspace("def", &[("geo/shapes.rhue", SHAPES), ("main.rhue", MAIN)]);
    let docs = Docs::default();
    let main = uri(&dir.join("main.rhue"));
    let def = |n: usize, needle: &str| {
        rhue_lsp::definition(&docs, &main, MAIN, pos_of(MAIN, needle, n, 1)).map(|l| at(&l))
    };
    assert_eq!(def(0, "area").as_deref(), Some("shapes.rhue:area"));
    assert_eq!(def(1, "area").as_deref(), Some("shapes.rhue:area"));
    assert_eq!(def(0, "unit").as_deref(), Some("shapes.rhue:unit"));
    assert_eq!(
        def(0, "perimeter").as_deref(),
        Some("shapes.rhue:perimeter")
    );
    // the local itself still goes to its declaration
    let l = rhue_lsp::definition(&docs, &main, MAIN, pos_of(MAIN, "shapes.area", 0, 1)).unwrap();
    assert_eq!(l.uri, main);
    // inside the module: uses of its own fields
    let shapes = uri(&dir.join("geo/shapes.rhue"));
    let l = rhue_lsp::definition(&docs, &shapes, SHAPES, pos_of(SHAPES, "M.area(s", 0, 3));
    assert_eq!(l.map(|l| at(&l)).as_deref(), Some("shapes.rhue:area"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn references_cross_modules() {
    let other = "local g = require('geo.shapes')\nreturn g.area(5, 5)\n";
    let unrelated = "local M = {}\nfunction M.area() end\nprint(M.area())\nreturn M\n";
    let dir = workspace(
        "refs",
        &[
            ("geo/shapes.rhue", SHAPES),
            ("main.rhue", MAIN),
            (
                "geo/other.rhue",
                "local g = require('shapes')\nreturn g.area(1, 1)\n",
            ),
            ("deep/user.rhue", other),
            ("unrelated.rhue", unrelated),
        ],
    );
    let mut docs = Docs::default();
    docs.roots = vec![dir.clone()];
    let main = uri(&dir.join("main.rhue"));
    let refs = |u: &Uri, text: &str, pos: Position| {
        let mut r: Vec<String> = rhue_lsp::references(&docs, u, text, pos)
            .iter()
            .map(|l| format!("{}@{}", at(l), l.range.start.line))
            .collect();
        r.sort();
        r
    };
    // from a use in another file. `deep/user.rhue` requires 'geo.shapes'
    // relative to itself, which doesn't exist: not a use
    let from_use = refs(&main, MAIN, pos_of(MAIN, "area", 0, 1));
    assert_eq!(
        from_use,
        [
            "main.rhue:area@1",
            "main.rhue:area@3",
            "other.rhue:area@1",
            "shapes.rhue:area@1",
            "shapes.rhue:area@5",
        ]
    );
    // from the definition: the same
    let shapes = uri(&dir.join("geo/shapes.rhue"));
    assert_eq!(
        refs(&shapes, SHAPES, pos_of(SHAPES, "area", 0, 1)),
        from_use
    );
    // a field defined by assigning a local: the field's uses and the local's
    let r = refs(&main, MAIN, pos_of(MAIN, "perimeter", 0, 1));
    assert_eq!(r, ["main.rhue:perimeter@3", "shapes.rhue:perimeter@4"]);
    // plain locals are unchanged
    let r = refs(&main, MAIN, pos_of(MAIN, "shapes", 0, 1));
    assert_eq!(r.len(), 4, "{r:?}");
    let _ = std::fs::remove_dir_all(dir);
}
