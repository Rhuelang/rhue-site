//! Document symbols (the outline) and workspace symbols (search by name).

use lsp_types::{DocumentSymbol, Location, SymbolInformation, SymbolKind, Uri};
use rhue::{Symbol, SymbolKind as Kind};

use crate::{Docs, LineIndex};

fn kind(k: Kind) -> SymbolKind {
    match k {
        Kind::Function => SymbolKind::FUNCTION,
        Kind::Method => SymbolKind::METHOD,
        Kind::Variable => SymbolKind::VARIABLE,
        Kind::Field => SymbolKind::FIELD,
        Kind::Module => SymbolKind::MODULE,
        Kind::Type => SymbolKind::INTERFACE,
        _ => SymbolKind::VARIABLE,
    }
}

/// The document's symbols, nested (`function M.f()` under `M`), with the
/// checker's type for each as its detail.
pub fn document_symbols(docs: &Docs, uri: &Uri, text: &str) -> Vec<DocumentSymbol> {
    let idx = LineIndex::new(text);
    let outline = rhue::outline(text);
    let analysis = docs.analyze(uri, text);
    let type_of = |s: &Symbol| {
        analysis
            .types
            .iter()
            .rev()
            .find(|(span, _)| *span == s.type_span)
            .map(|(_, t)| t.clone())
            .filter(|t| t != "any")
    };
    fn convert(
        s: &Symbol,
        idx: &LineIndex<'_>,
        type_of: &dyn Fn(&Symbol) -> Option<String>,
    ) -> DocumentSymbol {
        #[allow(deprecated)] // `deprecated` is a required field
        DocumentSymbol {
            name: s.name.clone(),
            detail: type_of(s),
            kind: kind(s.kind),
            tags: None,
            deprecated: None,
            range: idx.range(s.span),
            selection_range: idx.range(s.name_span),
            children: Some(
                s.children
                    .iter()
                    .map(|c| convert(c, idx, type_of))
                    .collect(),
            ),
        }
    }
    outline
        .symbols
        .iter()
        .map(|s| convert(s, &idx, &type_of))
        .collect()
}

/// Whether `query`'s characters show up in `name` in order (ignoring case).
fn matches(name: &str, query: &str) -> bool {
    let mut chars = name.chars().flat_map(char::to_lowercase);
    query
        .chars()
        .flat_map(char::to_lowercase)
        .all(|q| chars.any(|c| c == q))
}

/// Symbols across the workspace whose names fuzzy-match `query` (its characters
/// in order), 1000 at most.
pub fn workspace_symbols(docs: &Docs, query: &str) -> Vec<SymbolInformation> {
    const LIMIT: usize = 1000;
    let mut out = Vec::new();
    for path in docs.workspace_files() {
        let Some((text, outline)) = docs.outline_at(&path) else {
            continue;
        };
        let Ok(uri) = crate::uri::from_file_path(&path) else {
            continue;
        };
        let idx = LineIndex::new(&text);
        let mut stack: Vec<(&Symbol, Option<String>)> =
            outline.symbols.iter().rev().map(|s| (s, None)).collect();
        while let Some((s, container)) = stack.pop() {
            if matches(&s.name, query) {
                #[allow(deprecated)] // `deprecated` is a required field
                out.push(SymbolInformation {
                    name: s.name.clone(),
                    kind: kind(s.kind),
                    tags: None,
                    deprecated: None,
                    location: Location::new(uri.clone(), idx.range(s.name_span)),
                    container_name: container.clone(),
                });
                if out.len() >= LIMIT {
                    return out;
                }
            }
            for c in s.children.iter().rev() {
                stack.push((c, Some(s.name.clone())));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn fuzzy() {
        assert!(super::matches("newCounter", "nc"));
        assert!(super::matches("newCounter", "COUNT"));
        assert!(super::matches("x", ""));
        assert!(!super::matches("newCounter", "cw"));
    }
}
