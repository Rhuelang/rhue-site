//! Definitions and references across modules. A module's fields are whatever it
//! returns (see [`rhue::Exports`]), and another file uses one as `m.name` where
//! `m` is `require("...")`, directly or through a local. Only outlines are
//! needed, so every file in the workspace can get read.

use std::path::{Path, PathBuf};

use crate::uri::UriExt;
use lsp_types::{Location, Uri};
use rhue::{Base, Outline, Span};

use crate::{Docs, LineIndex, contains};

/// A module's field: the module's file and the field's name.
struct Target {
    path: PathBuf,
    name: String,
}

/// The module a field gets read from, by name, if it is one.
fn module_of<'a>(o: &'a Outline, base: &'a Base) -> Option<&'a str> {
    match base {
        Base::Module(m) => Some(m),
        Base::Local(decl) => o
            .requires
            .iter()
            .find(|(s, _)| s == decl)
            .map(|(_, m)| m.as_str()),
        _ => None,
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (a.canonicalize(), b.canonicalize()),
            (Ok(x), Ok(y)) if x == y
        )
}

/// The module field at `offset`, either a use of one (`m.name`) or where this
/// file defines one it returns.
fn target_at(docs: &Docs, uri: &Uri, outline: &Outline, offset: usize) -> Option<Target> {
    let here = uri.to_file_path().ok()?;
    if let Some(u) = outline.field_uses.iter().find(|u| contains(u.span, offset)) {
        if let Some(m) = module_of(outline, &u.base) {
            return Some(Target {
                path: docs.module_path(uri, m)?,
                name: u.name.clone(),
            });
        }
        return match u.base {
            Base::Local(d) if outline.exports.local == Some(d) => Some(Target {
                path: here,
                name: u.name.clone(),
            }),
            _ => None,
        };
    }
    outline
        .exports
        .fields
        .iter()
        .find(|(_, s)| contains(*s, offset))
        .map(|(n, _)| Target {
            path: here,
            name: n.clone(),
        })
}

/// The text and outline of `path`: this document's if it's the one, otherwise
/// the open or saved file's.
fn file(
    docs: &Docs,
    path: &Path,
    here: (&Path, &str, &std::rc::Rc<Outline>),
) -> Option<(String, std::rc::Rc<Outline>)> {
    if same_file(path, here.0) {
        return Some((here.1.to_string(), here.2.clone()));
    }
    docs.outline_at(path)
}

fn location(path: &Path, text: &str, span: Span) -> Option<Location> {
    Some(Location::new(
        crate::uri::from_file_path(path).ok()?,
        LineIndex::new(text).range(span),
    ))
}

/// Where the module field at `offset` is defined.
pub(crate) fn definition(docs: &Docs, uri: &Uri, text: &str, offset: usize) -> Option<Location> {
    let outline = std::rc::Rc::new(rhue::outline(text));
    let t = target_at(docs, uri, &outline, offset)?;
    let here = uri.to_file_path().ok()?;
    let (ptext, po) = file(docs, &t.path, (&here, text, &outline))?;
    let (_, span) = po.exports.fields.iter().find(|(n, _)| *n == t.name)?;
    location(&t.path, &ptext, *span)
}

/// Every use of the module field at `offset` in the workspace, plus its
/// definition. `None` if there's no module field there.
pub(crate) fn references(
    docs: &Docs,
    uri: &Uri,
    text: &str,
    offset: usize,
) -> Option<Vec<Location>> {
    let outline = std::rc::Rc::new(rhue::outline(text));
    let t = target_at(docs, uri, &outline, offset)?;
    let here = uri.to_file_path().ok()?;
    let mut out = Vec::new();
    if let Some((ptext, po)) = file(docs, &t.path, (&here, text, &outline))
        && let Some((_, span)) = po.exports.fields.iter().find(|(n, _)| *n == t.name)
    {
        out.extend(location(&t.path, &ptext, *span));
    }
    let mut files = docs.workspace_files();
    files.push(here.clone());
    files.push(t.path.clone());
    files.sort();
    files.dedup();
    for f in files {
        let Some((ftext, fo)) = file(docs, &f, (&here, text, &outline)) else {
            continue;
        };
        let Ok(furi) = crate::uri::from_file_path(&f) else {
            continue;
        };
        for u in fo.field_uses.iter().filter(|u| u.name == t.name) {
            let hit = match module_of(&fo, &u.base) {
                Some(m) => docs
                    .module_path(&furi, m)
                    .is_some_and(|p| same_file(&p, &t.path)),
                None => {
                    same_file(&f, &t.path)
                        && matches!(u.base, Base::Local(d) if fo.exports.local == Some(d))
                }
            };
            if hit {
                out.extend(location(&f, &ftext, u.span));
            }
        }
    }
    crate::dedup(&mut out);
    Some(out)
}
