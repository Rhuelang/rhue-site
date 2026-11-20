//! Inlay hints and code actions: the checker's fixes for errors (the name you
//! probably meant, a nil check), and writing an inferred type in.

use std::collections::HashMap;

use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, InlayHint, InlayHintKind, InlayHintLabel,
    Range, TextEdit, Uri, WorkspaceEdit,
};

use crate::{Docs, LineIndex, to_lsp};

/// The inferred types in `range` the source doesn't spell out: locals, loop
/// variables, parameters and results. A hint with a writable type gets inserted
/// when you double-click it.
pub fn inlay_hints(docs: &Docs, uri: &Uri, text: &str, range: Range) -> Vec<InlayHint> {
    let idx = LineIndex::new(text);
    let (from, to) = (idx.offset(range.start), idx.offset(range.end));
    let analysis = docs.analyze(uri, text);
    analysis
        .hints
        .iter()
        .filter(|h| (from..=to).contains(&(h.offset as usize)))
        .map(|h| {
            let position = idx.position(h.offset as usize);
            InlayHint {
                position,
                label: InlayHintLabel::String(h.label.clone()),
                kind: Some(InlayHintKind::TYPE),
                text_edits: h.insert.as_ref().map(|t| {
                    vec![TextEdit {
                        range: Range::new(position, position),
                        new_text: t.clone(),
                    }]
                }),
                tooltip: None,
                padding_left: None,
                padding_right: None,
                data: None,
            }
        })
        .collect()
}

fn edit(uri: &Uri, edits: Vec<TextEdit>) -> WorkspaceEdit {
    WorkspaceEdit {
        changes: Some(HashMap::from([(uri.clone(), edits)])),
        ..WorkspaceEdit::default()
    }
}

/// What you can do in `range`: fixes for errors touching it, then writing in
/// the inferred types of names declared on its lines.
pub fn code_actions(docs: &Docs, uri: &Uri, text: &str, range: Range) -> Vec<CodeActionOrCommand> {
    let idx = LineIndex::new(text);
    let (from, to) = (idx.offset(range.start), idx.offset(range.end));
    let analysis = docs.analyze(uri, text);
    let mut out = Vec::new();
    for d in &analysis.diagnostics {
        let span = d.primary.span;
        if (span.end as usize) < from || (span.start as usize) > to {
            continue;
        }
        for (i, fix) in d.fixes.iter().enumerate() {
            let edits = fix
                .edits
                .iter()
                .map(|(s, t)| TextEdit {
                    range: idx.range(*s),
                    new_text: t.clone(),
                })
                .collect();
            out.push(CodeActionOrCommand::CodeAction(CodeAction {
                title: fix.title.clone(),
                kind: Some(CodeActionKind::QUICKFIX),
                diagnostics: Some(vec![to_lsp(&idx, d)]),
                edit: Some(edit(uri, edits)),
                is_preferred: Some(i == 0),
                ..CodeAction::default()
            }));
        }
    }
    // annotations, for hints on the lines the range covers
    let first = idx.offset(lsp_types::Position::new(range.start.line, 0));
    let last = idx.offset(lsp_types::Position::new(range.end.line + 1, 0));
    for h in &analysis.hints {
        let at = h.offset as usize;
        let Some(insert) = &h.insert else {
            continue;
        };
        if at < first || at > last || (at == last && last != text.len()) {
            continue;
        }
        let title = match h.kind {
            rhue::HintKind::Type => {
                format!("Add type annotation `{}`", insert.trim_start_matches(": "))
            }
            rhue::HintKind::Return => {
                format!(
                    "Add return type annotation `{}`",
                    insert.trim_start_matches(": ")
                )
            }
            _ => format!("Add annotation `{}`", insert.trim_start_matches(": ")),
        };
        let position = idx.position(at);
        out.push(CodeActionOrCommand::CodeAction(CodeAction {
            title,
            kind: Some(CodeActionKind::REFACTOR_REWRITE),
            edit: Some(edit(
                uri,
                vec![TextEdit {
                    range: Range::new(position, position),
                    new_text: insert.clone(),
                }],
            )),
            ..CodeAction::default()
        }));
    }
    out
}
