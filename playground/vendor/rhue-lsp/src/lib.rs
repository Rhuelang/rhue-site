//! The language server's analysis, kept apart from the protocol plumbing in
//! `main.rs` (so it can be tested on plain strings).
//!
//! Requests analyze the document with [`Engine::analyze`] (parse, resolve,
//! check, and record expression types, local definitions and references, and
//! members), which takes a few milliseconds for a normal script. [`Docs`] keeps
//! an engine per document and caches analyses (see there). Modules a document
//! `require`s get found next to it on disk (`a.b` is `a/b.rhue` or
//! `a/b/init.rhue`), preferring the text of documents open in the editor.
//!
//! Positions are LSP's, lines and UTF-16 columns.

use std::cell::{Cell, RefCell, RefMut};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::uri::UriExt;
use lsp_types::{
    CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Hover, HoverContents,
    Location, MarkupContent, MarkupKind, ParameterInformation, ParameterLabel, Position, Range,
    SignatureHelp, SignatureInformation, TextEdit, Uri, WorkspaceEdit,
};
use rhue::{Analysis, Engine, Outline, Span, TypeMode};

mod actions;
mod crossfile;
mod symbols;
mod tokens;
pub mod uri;

pub use actions::{code_actions, inlay_hints};
pub use symbols::{document_symbols, workspace_symbols};
pub use tokens::{LEGEND_MODIFIERS, LEGEND_TYPES, semantic_tokens};

/// Converts between byte offsets and LSP positions for one text.
pub struct LineIndex<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    pub fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        LineIndex { text, starts }
    }

    #[expect(
        clippy::cast_possible_truncation,
        reason = "positions in a source, capped at 4 GiB by the lexer"
    )]
    pub fn position(&self, offset: usize) -> Position {
        let offset = offset.min(self.text.len());
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let col: usize = self.text[self.starts[line]..offset]
            .chars()
            .map(char::len_utf16)
            .sum();
        Position::new(line as u32, col as u32)
    }

    #[expect(
        clippy::cast_possible_truncation,
        reason = "positions in a source, capped at 4 GiB by the lexer"
    )]
    pub fn offset(&self, pos: Position) -> usize {
        let Some(&start) = self.starts.get(pos.line as usize) else {
            return self.text.len();
        };
        let mut units = 0u32;
        for (i, c) in self.text[start..].char_indices() {
            if units >= pos.character || c == '\n' {
                return start + i;
            }
            units += c.len_utf16() as u32;
        }
        self.text.len()
    }

    pub fn range(&self, span: Span) -> Range {
        Range::new(
            self.position(span.start as usize),
            self.position(span.end as usize),
        )
    }
}

/// The documents open in the editor, and what's been worked out about them.
///
/// Analysis is incremental per file. Each document keeps its own [`Engine`],
/// which remembers the types of the modules it `require`s, so typing in a file
/// only re-checks that file. The last analysis of each document is cached by
/// its text, so the pile of requests an editor sends after a keystroke
/// (diagnostics, then hover, signature help, ...) share one. Changing, opening
/// or closing another document, or a file changing on disk, throws out whatever
/// could depend on it.
#[derive(Default)]
pub struct Docs {
    pub open: HashMap<Uri, String>,
    engines: RefCell<HashMap<Uri, (Engine, Deps)>>,
    analyses: RefCell<HashMap<Uri, (String, Rc<Analysis>)>>,
    /// Outlines of files (open or on disk) by path, with the text each one was
    /// made from.
    outlines: RefCell<HashMap<PathBuf, (String, Rc<Outline>)>>,
    /// The workspace folders, searched for symbols and references.
    pub roots: Vec<PathBuf>,
    stats: Rc<Stats>,
}

/// The module files an engine has read (directly or not).
type Deps = Rc<RefCell<HashSet<PathBuf>>>;

/// How much work the server's done (for tests and logging).
#[derive(Default, Debug)]
pub struct Stats {
    /// Documents analyzed (cache misses).
    pub analyses: Cell<u32>,
    /// Module sources read while checking `require`s.
    pub module_loads: Cell<u32>,
}

impl Docs {
    /// A document got opened, or its whole text replaced. Returns the other
    /// open documents whose analysis might have changed.
    pub fn set_text(&mut self, uri: &Uri, text: String) -> Vec<Uri> {
        self.open.insert(uri.clone(), text);
        self.invalidate(uri)
    }

    /// Applies an editor's change to a document, either a range swapped for new
    /// text or (no range) the whole text. Returns the other open documents
    /// whose analysis might have changed (they `require` it).
    pub fn apply_change(&mut self, uri: &Uri, range: Option<Range>, new_text: &str) -> Vec<Uri> {
        let Some(text) = self.open.get_mut(uri) else {
            return Vec::new();
        };
        match range {
            Some(r) => {
                let idx = LineIndex::new(text);
                let (start, end) = (idx.offset(r.start), idx.offset(r.end));
                let end = end.max(start);
                text.replace_range(start..end, new_text);
            }
            None => *text = new_text.to_string(),
        }
        self.invalidate(uri)
    }

    /// Closes a document (modules read its file on disk from now on).
    pub fn close(&mut self, uri: &Uri) -> Vec<Uri> {
        self.open.remove(uri);
        self.engines.borrow_mut().remove(uri);
        self.analyses.borrow_mut().remove(uri);
        self.invalidate(uri)
    }

    /// Files changed on disk (saved, or changed outside the editor). Every
    /// document that read a module might see new types, so those get returned.
    pub fn files_changed(&mut self) -> Vec<Uri> {
        let mut affected: Vec<Uri> = self
            .engines
            .borrow()
            .iter()
            .filter(|(_, (_, deps))| !deps.borrow().is_empty())
            .map(|(u, _)| u.clone())
            .collect();
        affected.sort();
        for u in &affected {
            self.engines.borrow_mut().remove(u);
            self.analyses.borrow_mut().remove(u);
        }
        affected
    }

    /// `changed` has new text: forget its analysis, plus the engines and
    /// analyses of documents that read it as a module. Its own engine stays,
    /// the modules *it* requires didn't change.
    fn invalidate(&mut self, changed: &Uri) -> Vec<Uri> {
        self.analyses.borrow_mut().remove(changed);
        let Ok(path) = changed.to_file_path() else {
            return Vec::new();
        };
        let mut affected: Vec<Uri> = self
            .engines
            .borrow()
            .iter()
            .filter(|(u, (_, deps))| *u != changed && deps.borrow().contains(&path))
            .map(|(u, _)| u.clone())
            .collect();
        affected.sort();
        for u in &affected {
            self.engines.borrow_mut().remove(u);
            self.analyses.borrow_mut().remove(u);
        }
        affected
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    /// `uri`'s analysis of `text` (with no member query), cached.
    pub fn analyze(&self, uri: &Uri, text: &str) -> Rc<Analysis> {
        if let Some((t, a)) = self.analyses.borrow().get(uri)
            && t == text
        {
            return a.clone();
        }
        let a = Rc::new(self.engine_for(uri).analyze(text, None));
        self.stats.analyses.set(self.stats.analyses.get() + 1);
        self.analyses
            .borrow_mut()
            .insert(uri.clone(), (text.to_string(), a.clone()));
        a
    }

    /// The path of the module `name` as `uri`'s document would `require` it, if
    /// there is one (open in the editor or on disk).
    pub fn module_path(&self, uri: &Uri, name: &str) -> Option<PathBuf> {
        if !rhue::is_module_name(name) {
            return None;
        }
        let dir = uri.to_file_path().ok()?.parent()?.to_path_buf();
        rhue::module_paths(&dir, name)
            .into_iter()
            .find(|p| self.text_at(p).is_some())
    }

    /// The outline of the file at `path` (its open text if it's open), and that
    /// text. Cached by text.
    pub fn outline_at(&self, path: &Path) -> Option<(String, Rc<Outline>)> {
        let text = self.text_at(path)?;
        if let Some((t, o)) = self.outlines.borrow().get(path)
            && *t == text
        {
            return Some((text, o.clone()));
        }
        let o = Rc::new(rhue::outline(&text));
        self.outlines
            .borrow_mut()
            .insert(path.to_path_buf(), (text.clone(), o.clone()));
        Some((text, o))
    }

    /// Every `.rhue` file in the workspace folders (skipping hidden folders,
    /// `target` and `node_modules`), plus every open document.
    pub fn workspace_files(&self) -> Vec<PathBuf> {
        const MAX_FILES: usize = 20_000;
        let mut out: Vec<PathBuf> = self
            .open
            .keys()
            .filter_map(|u| u.to_file_path().ok())
            .collect();
        let mut stack: Vec<PathBuf> = self.roots.clone();
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    if !name.starts_with('.') && name != "target" && name != "node_modules" {
                        stack.push(path);
                    }
                } else if name.ends_with(".rhue") && out.len() < MAX_FILES {
                    out.push(path);
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    fn text_at(&self, path: &Path) -> Option<String> {
        let open = crate::uri::from_file_path(path)
            .ok()
            .and_then(|u| self.open.get(&u).cloned());
        open.or_else(|| std::fs::read_to_string(path).ok())
    }

    /// The engine that analyzes `uri`. Unchecked files get checked non-strictly
    /// (annotations are checked, nothing else), and modules resolve next to the
    /// document. It's kept until something it might depend on changes. Don't
    /// hold onto it across a call to [`analyze`](Self::analyze).
    pub fn engine_for(&self, uri: &Uri) -> RefMut<'_, Engine> {
        RefMut::map(self.engines.borrow_mut(), |engines| {
            &mut engines
                .entry(uri.clone())
                .or_insert_with(|| self.new_engine(uri))
                .0
        })
    }

    fn new_engine(&self, uri: &Uri) -> (Engine, Deps) {
        let mut engine = Engine::new();
        engine.set_default_type_mode(TypeMode::NonStrict);
        let snapshot: HashMap<PathBuf, String> = self
            .open
            .iter()
            .filter_map(|(u, t)| Some((u.to_file_path().ok()?, t.clone())))
            .collect();
        let dir = uri
            .to_file_path()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let stats = self.stats.clone();
        let deps: Deps = Rc::default();
        let seen = deps.clone();
        engine.set_module_loader(move |name| {
            let dir = dir.as_ref()?;
            if !rhue::is_module_name(name) {
                return None;
            }
            stats.module_loads.set(stats.module_loads.get() + 1);
            let candidates = rhue::module_paths(dir, name);
            // both candidates count, creating the missing one changes things
            seen.borrow_mut().extend(candidates.iter().cloned());
            candidates.iter().find_map(|p| {
                snapshot
                    .get(p)
                    .cloned()
                    .or_else(|| std::fs::read_to_string(p).ok())
            })
        });
        (engine, deps)
    }
}

pub fn diagnostics(docs: &Docs, uri: &Uri, text: &str) -> Vec<Diagnostic> {
    let idx = LineIndex::new(text);
    let analysis = docs.analyze(uri, text);
    analysis
        .diagnostics
        .iter()
        .map(|d| to_lsp(&idx, d))
        .collect()
}

fn to_lsp(idx: &LineIndex<'_>, d: &rhue::Diagnostic) -> Diagnostic {
    let mut message = d.message.clone();
    for note in d.notes.iter().chain(&d.help) {
        message.push('\n');
        message.push_str(note);
    }
    Diagnostic {
        range: idx.range(d.primary.span),
        severity: Some(match d.severity {
            rhue::Severity::Error => DiagnosticSeverity::ERROR,
            rhue::Severity::Warning => DiagnosticSeverity::WARNING,
            _ => DiagnosticSeverity::INFORMATION,
        }),
        source: Some("rhue".into()),
        message,
        ..Diagnostic::default()
    }
}

/// Drops repeated locations, keeping the first of each.
fn dedup(locations: &mut Vec<Location>) {
    let mut seen = Vec::new();
    locations.retain(|l| {
        let key = (l.uri.clone(), l.range);
        let new = !seen.contains(&key);
        if new {
            seen.push(key);
        }
        new
    });
}

fn contains(span: Span, offset: usize) -> bool {
    (span.start as usize) <= offset && offset <= span.end as usize
}

fn smallest<T>(items: impl Iterator<Item = (Span, T)>, offset: usize) -> Option<(Span, T)> {
    items
        .filter(|(s, _)| contains(*s, offset))
        .min_by_key(|(s, _)| (s.end - s.start, s.start))
}

/// The type of what's under the cursor, a name or the smallest expression.
pub fn hover(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Option<Hover> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let analysis = docs.analyze(uri, text);
    let (span, ty) = smallest(analysis.types.iter().map(|(s, t)| (*s, t.clone())), offset)?;
    let snippet = &text[span.start as usize..span.end as usize];
    let is_name = !snippet.is_empty()
        && snippet
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !snippet.starts_with(|c: char| c.is_ascii_digit());
    let shown = if is_name {
        format!("{snippet}: {ty}")
    } else {
        ty
    };
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("```luau\n{shown}\n```"),
        }),
        range: Some(idx.range(span)),
    })
}

/// The string literal of a `require("...")` call under the cursor.
fn require_at(text: &str, offset: usize) -> Option<String> {
    let start = text[..offset].rfind(['"', '\''])?;
    let quote = text.as_bytes()[start] as char;
    let end = offset + text[offset..].find(quote)?;
    let before = text[..start].trim_end();
    let before = before.strip_suffix('(').unwrap_or(before).trim_end();
    if !before.ends_with("require") {
        return None;
    }
    let name = &text[start + 1..end];
    (!name.contains(['\n', ' '])).then(|| name.to_string())
}

/// Where the local under the cursor is declared, or the file a `require("...")`
/// under the cursor loads.
pub fn definition(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Option<Location> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    if let Some(name) = require_at(text, offset) {
        let path = docs.module_path(uri, &name)?;
        return Some(Location::new(
            crate::uri::from_file_path(path).ok()?,
            Range::default(),
        ));
    }
    if let Some(l) = crossfile::definition(docs, uri, text, offset) {
        return Some(l);
    }
    let analysis = docs.analyze(uri, text);
    let decl = declaration_at(&analysis, offset)?;
    Some(Location::new(uri.clone(), idx.range(decl)))
}

fn declaration_at(analysis: &rhue::Analysis, offset: usize) -> Option<Span> {
    smallest(analysis.refs.iter().copied(), offset)
        .map(|(_, decl)| decl)
        .or_else(|| {
            analysis
                .locals
                .iter()
                .find(|(_, s)| contains(*s, offset))
                .map(|(_, s)| *s)
        })
}

/// Every use of the local under the cursor (and its declaration), or of the
/// module field under it, across the workspace.
pub fn references(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Vec<Location> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let across = crossfile::references(docs, uri, text, offset);
    let analysis = docs.analyze(uri, text);
    let Some(decl) = declaration_at(&analysis, offset) else {
        return across.unwrap_or_default();
    };
    // a local a module returns as a field (`return { f = f }`), so both
    if let Some(mut across) = across {
        for s in analysis
            .refs
            .iter()
            .filter(|(_, d)| *d == decl)
            .map(|(s, _)| *s)
        {
            across.push(Location::new(uri.clone(), idx.range(s)));
        }
        dedup(&mut across);
        return across;
    }
    let mut spans: Vec<Span> = vec![decl];
    spans.extend(
        analysis
            .refs
            .iter()
            .filter(|(_, d)| *d == decl)
            .map(|(s, _)| *s),
    );
    spans.sort_by_key(|s| (s.start, s.end));
    spans.dedup();
    spans
        .into_iter()
        .map(|s| Location::new(uri.clone(), idx.range(s)))
        .collect()
}

const KEYWORDS: &[&str] = &[
    "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for",
    "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
    "type", "typeof", "until", "while",
];

fn kind_of(ty: &str) -> CompletionItemKind {
    if ty.starts_with('(') || ty.starts_with('<') {
        CompletionItemKind::FUNCTION
    } else {
        CompletionItemKind::VARIABLE
    }
}

/// What can go at the cursor: members after `expr.` / `expr:`, otherwise locals
/// declared above, globals and keywords.
#[expect(
    clippy::cast_possible_truncation,
    reason = "positions in a source, capped at 4 GiB by the lexer"
)]
pub fn completion(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Vec<CompletionItem> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let word_start = text[..offset]
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .map_or(0, |i| i + 1);
    let trigger = text[..word_start].chars().next_back();
    let mut engine = docs.engine_for(uri);
    if let Some(sep @ ('.' | ':')) = trigger {
        let dot = word_start - 1;
        // make the code parse: a name after the separator, and call parentheses
        // (a method needs them, and they make `obj.name` a statement)
        let mut patched = String::with_capacity(text.len() + 16);
        patched.push_str(&text[..offset]);
        if word_start == offset {
            patched.push_str("__complete");
        }
        patched.push_str("()");
        patched.push_str(&text[offset..]);
        let analysis = engine.analyze(&patched, Some(dot as u32));
        return analysis
            .members
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, ty)| sep == '.' || ty.starts_with('(') || ty.starts_with('<'))
            .map(|(name, ty)| CompletionItem {
                kind: Some(if sep == ':' {
                    CompletionItemKind::METHOD
                } else if ty.starts_with('(') || ty.starts_with('<') {
                    CompletionItemKind::FUNCTION
                } else {
                    CompletionItemKind::FIELD
                }),
                label: name,
                detail: Some(ty),
                ..CompletionItem::default()
            })
            .collect();
    }
    drop(engine);
    let mut analysis = docs.analyze(uri, text);
    if analysis.locals.is_empty() && !analysis.diagnostics.is_empty() {
        // half-edited code that doesn't parse, try with a name at the cursor
        let patched = format!("{}__complete{}", &text[..offset], &text[offset..]);
        let retry = docs.engine_for(uri).analyze(&patched, None);
        if !retry.locals.is_empty() {
            analysis = Rc::new(retry);
        }
    }
    let types: HashMap<Span, &String> = analysis.types.iter().map(|(s, t)| (*s, t)).collect();
    let mut items: Vec<CompletionItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (name, span) in analysis.locals.iter().rev() {
        if (span.start as usize) < word_start && seen.insert(name.clone()) {
            let ty = types.get(span).map(|t| (*t).clone());
            items.push(CompletionItem {
                kind: Some(ty.as_deref().map_or(CompletionItemKind::VARIABLE, kind_of)),
                label: name.clone(),
                detail: ty,
                ..CompletionItem::default()
            });
        }
    }
    for (name, ty) in &analysis.globals {
        if seen.insert(name.clone()) {
            items.push(CompletionItem {
                kind: Some(if ty.starts_with('{') {
                    CompletionItemKind::MODULE
                } else {
                    kind_of(ty)
                }),
                label: name.clone(),
                detail: Some(ty.clone()),
                ..CompletionItem::default()
            });
        }
    }
    for kw in KEYWORDS {
        items.push(CompletionItem {
            kind: Some(CompletionItemKind::KEYWORD),
            label: kw.to_string(),
            ..CompletionItem::default()
        });
    }
    items
}

/// The whole document formatted (`None` if it doesn't parse or is already
/// formatted).
pub fn formatting(text: &str, insert_spaces: bool, tab_size: u32) -> Option<Vec<TextEdit>> {
    let options = rhue_fmt::FormatOptions {
        indent: if insert_spaces {
            " ".repeat(tab_size as usize)
        } else {
            "\t".into()
        },
    };
    let out = rhue_fmt::format(text, &options).ok()?;
    if out == text {
        return Some(Vec::new());
    }
    let idx = LineIndex::new(text);
    Some(vec![TextEdit::new(
        Range::new(Position::new(0, 0), idx.position(text.len())),
        out,
    )])
}

/// The name a rename at the cursor would change, a local or nothing.
pub fn prepare_rename(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Option<Range> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let analysis = docs.analyze(uri, text);
    declaration_at(&analysis, offset)?;
    let span = smallest(analysis.refs.iter().map(|(s, _)| (*s, ())), offset)
        .map(|(s, _)| s)
        .or_else(|| {
            analysis
                .locals
                .iter()
                .find(|(_, s)| contains(*s, offset))
                .map(|(_, s)| *s)
        })?;
    Some(idx.range(span))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !KEYWORDS.contains(&name)
}

/// Renames the local under the cursor everywhere it's used. Refused for globals
/// and fields (other files might use them), for names that aren't identifiers,
/// and when the new name would change what some name points at (shadowing, or
/// getting shadowed by, another variable).
#[expect(
    clippy::cast_possible_truncation,
    reason = "positions in a source, capped at 4 GiB by the lexer"
)]
pub fn rename(
    docs: &Docs,
    uri: &Uri,
    text: &str,
    pos: Position,
    new_name: &str,
) -> Result<WorkspaceEdit, String> {
    if !is_identifier(new_name) {
        return Err(format!("`{new_name}` isn't a valid name"));
    }
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let analysis = docs.analyze(uri, text);
    let mut engine = docs.engine_for(uri);
    let decl = declaration_at(&analysis, offset)
        .ok_or("only locals can be renamed (globals and fields may be used elsewhere)")?;
    let mut sites: Vec<Span> = vec![decl];
    sites.extend(
        analysis
            .refs
            .iter()
            .filter(|(_, d)| *d == decl)
            .map(|(s, _)| *s),
    );
    sites.sort_by_key(|s| s.start);
    sites.dedup();

    // apply the edit and make sure every name still means what it did
    let mut renamed = String::with_capacity(text.len());
    let mut last = 0;
    for s in &sites {
        renamed.push_str(&text[last..s.start as usize]);
        renamed.push_str(new_name);
        last = s.end as usize;
    }
    renamed.push_str(&text[last..]);
    let old_len = sites[0].end - sites[0].start;
    let delta = new_name.len() as i64 - old_len as i64;
    let shift = |off: u32| -> u32 {
        let before = sites.iter().filter(|s| s.start < off).count() as i64;
        (off as i64 + delta * before) as u32
    };
    let moved = |s: Span| -> Span {
        let start = shift(s.start);
        let end = if sites.iter().any(|x| x.start == s.start) {
            start + new_name.len() as u32
        } else {
            shift(s.end)
        };
        Span::new(start, end)
    };
    let mut expected: Vec<(Span, Span)> = analysis
        .refs
        .iter()
        .map(|(r, d)| (moved(*r), moved(*d)))
        .collect();
    let after = engine.analyze(&renamed, None);
    let mut actual = after.refs.clone();
    expected.sort_by_key(|(r, d)| (r.start, r.end, d.start));
    actual.sort_by_key(|(r, d)| (r.start, r.end, d.start));
    expected.dedup();
    actual.dedup();
    if expected != actual {
        return Err(format!(
            "renaming to `{new_name}` would change what another name refers to"
        ));
    }
    let edits = sites
        .iter()
        .map(|s| TextEdit::new(idx.range(*s), new_name.to_string()))
        .collect();
    Ok(WorkspaceEdit {
        changes: Some(HashMap::from([(uri.clone(), edits)])),
        ..WorkspaceEdit::default()
    })
}

/// The innermost unclosed `(` before `offset`, and how many top-level commas
/// come after it (skipping strings, comments and nested brackets).
fn open_call(text: &str, offset: usize) -> Option<(usize, u32)> {
    let b = text.as_bytes();
    let mut stack: Vec<(u8, usize, u32)> = Vec::new();
    let mut i = 0;
    let long_bracket = |i: usize| -> Option<(usize, usize)> {
        // `[==[` at i, returns (level, length of the opener)
        if b.get(i) != Some(&b'[') {
            return None;
        }
        let mut j = i + 1;
        while b.get(j) == Some(&b'=') {
            j += 1;
        }
        (b.get(j) == Some(&b'[')).then(|| (j - i - 1, j - i + 1))
    };
    let skip_long = |from: usize, level: usize| -> usize {
        let close = format!("]{}]", "=".repeat(level));
        text[from..]
            .find(&close)
            .map_or(text.len(), |k| from + k + close.len())
    };
    while i < offset.min(b.len()) {
        match b[i] {
            b'-' if b.get(i + 1) == Some(&b'-') => {
                if let Some((level, len)) = long_bracket(i + 2) {
                    i = skip_long(i + 2 + len, level);
                } else {
                    i = text[i..].find('\n').map_or(text.len(), |k| i + k);
                }
                continue;
            }
            q @ (b'"' | b'\'' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != q && b[i] != b'\n' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'[' => {
                if let Some((level, len)) = long_bracket(i) {
                    i = skip_long(i + len, level);
                    continue;
                }
                stack.push((b'[', i, 0));
            }
            c @ (b'(' | b'{') => stack.push((c, i, 0)),
            b')' | b']' | b'}' => {
                stack.pop();
            }
            b',' => {
                if let Some(top) = stack.last_mut() {
                    top.2 += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if i > offset {
        return None; // inside a string or comment
    }
    let (_, at, commas) = stack.pop().filter(|(c, _, _)| *c == b'(')?;
    Some((at, commas))
}

/// Splits `(a, b) -> r` (or `<T>(a) -> r`) into its parameters and the rest.
fn split_function_type(ty: &str) -> Option<(Vec<String>, String)> {
    let mut s = ty.trim();
    if s.starts_with('<') {
        let mut depth = 0;
        let end = s.char_indices().find(|&(_, c)| {
            match c {
                '<' => depth += 1,
                '>' => depth -= 1,
                _ => {}
            }
            depth == 0
        })?;
        s = &s[end.0 + 1..];
    }
    let s = s.strip_prefix('(')?;
    let mut depth = 0;
    let mut params = Vec::new();
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '(' | '{' | '[' | '<' => depth += 1,
            ')' if depth == 0 => {
                let last = s[start..i].trim();
                if !last.is_empty() {
                    params.push(last.to_string());
                }
                let rest = s[i + 1..].trim();
                return Some((params, rest.to_string()));
            }
            ')' | '}' | ']' | '>' => depth -= 1,
            ',' if depth == 0 => {
                params.push(s[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    None
}

/// The parameter names of the function `callee` is defined as in `text`
/// (`function callee(...)`, `local function callee(...)` or `callee =
/// function(...)`), if it is one.
fn parameter_names(text: &str, callee: &str) -> Option<Vec<String>> {
    let defs = [
        format!("function {callee}("),
        format!("{callee} = function("),
    ];
    let open = defs.iter().find_map(|d| {
        text.match_indices(d.as_str())
            .find(|(i, _)| {
                !text[..*i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':')
            })
            .map(|(i, _)| i + d.len())
    })?;
    let close = open + text[open..].find(')')?;
    let names = text[open..close]
        .split(',')
        .map(|p| p.split(':').next().unwrap_or("").trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    Some(names)
}

/// The signature of the call the cursor's in, with the argument it's at.
#[expect(
    clippy::cast_possible_truncation,
    reason = "positions in a source, capped at 4 GiB by the lexer"
)]
pub fn signature_help(docs: &Docs, uri: &Uri, text: &str, pos: Position) -> Option<SignatureHelp> {
    let idx = LineIndex::new(text);
    let offset = idx.offset(pos);
    let (paren, commas) = open_call(text, offset)?;
    let callee_end = text[..paren].trim_end().len();
    let callee_start = text[..callee_end]
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':'))
        .map_or(0, |i| i + 1);
    let callee = &text[callee_start..callee_end];
    if callee.is_empty() || callee.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let sep = callee.rfind(['.', ':']).map(|i| callee_start + i);
    let method = sep.is_some_and(|i| text.as_bytes()[i] == b':');

    // half-edited calls rarely parse, try a name at the cursor, then a `)`
    let mut engine = docs.engine_for(uri);
    let candidates = [
        text.to_string(),
        format!("{}__complete{}", &text[..offset], &text[offset..]),
        format!("{}__complete){}", &text[..offset], &text[offset..]),
    ];
    let ty = candidates.iter().find_map(|src| match sep {
        Some(dot) => {
            let analysis = engine.analyze(src, Some(dot as u32));
            let name = &text[dot + 1..callee_end];
            analysis
                .members?
                .into_iter()
                .find(|(n, _)| n == name)
                .map(|(_, t)| t)
        }
        None => engine
            .analyze(src, None)
            .types
            .into_iter()
            .find(|(s, _)| s.start as usize == callee_start && s.end as usize == callee_end)
            .map(|(_, t)| t),
    })?;
    let (mut params, rest) = split_function_type(&ty)?;
    let mut names = parameter_names(text, callee).unwrap_or_default();
    if method {
        // `obj:m(...)` passes `obj` as the first parameter
        if !params.is_empty() {
            params.remove(0);
        }
        if names.first().is_some_and(|n| n == "self") {
            names.remove(0);
        }
    }
    let labelled: Vec<String> = if names.len() == params.len() {
        names
            .iter()
            .zip(&params)
            .map(|(n, t)| {
                if n == "..." {
                    t.clone()
                } else {
                    format!("{n}: {t}")
                }
            })
            .collect()
    } else {
        params.clone()
    };
    let mut label = format!("{callee}(");
    let utf16 = |s: &str| s.encode_utf16().count() as u32;
    let mut parameters = Vec::new();
    for (i, p) in labelled.iter().enumerate() {
        if i > 0 {
            label.push_str(", ");
        }
        let start = utf16(&label);
        label.push_str(p);
        parameters.push(ParameterInformation {
            label: ParameterLabel::LabelOffsets([start, utf16(&label)]),
            documentation: None,
        });
    }
    label.push(')');
    if !rest.is_empty() && rest != "-> ()" {
        label.push(' ');
        label.push_str(&rest);
    }
    let variadic = params.last().is_some_and(|p| p.starts_with("..."));
    let active = if variadic {
        commas.min(params.len().saturating_sub(1) as u32)
    } else {
        commas
    };
    Some(SignatureHelp {
        signatures: vec![SignatureInformation {
            label,
            documentation: None,
            parameters: Some(parameters),
            active_parameter: Some(active),
        }],
        active_signature: Some(0),
        active_parameter: Some(active),
    })
}
