//! Semantic tokens. Every keyword, literal and name gets classified (a local or
//! a global, a parameter, a function, a field, a type...), so highlighting
//! knows what names actually are.

use std::collections::HashSet;

use lsp_types::{SemanticToken, SemanticTokenModifier, SemanticTokenType, SemanticTokens};
use rhue::TokenKind;

use crate::LineIndex;

/// The token types, in the order the legend gives them.
pub const LEGEND_TYPES: &[SemanticTokenType] = &[
    SemanticTokenType::KEYWORD,
    SemanticTokenType::STRING,
    SemanticTokenType::NUMBER,
    SemanticTokenType::VARIABLE,
    SemanticTokenType::PARAMETER,
    SemanticTokenType::FUNCTION,
    SemanticTokenType::METHOD,
    SemanticTokenType::PROPERTY,
    SemanticTokenType::TYPE,
    SemanticTokenType::TYPE_PARAMETER,
    SemanticTokenType::NAMESPACE,
];

/// The modifiers, as bits in this order.
pub const LEGEND_MODIFIERS: &[SemanticTokenModifier] = &[
    SemanticTokenModifier::DECLARATION,
    SemanticTokenModifier::DEFAULT_LIBRARY,
];

fn type_index(k: TokenKind) -> u32 {
    match k {
        TokenKind::Keyword => 0,
        TokenKind::String => 1,
        TokenKind::Number => 2,
        TokenKind::Variable => 3,
        TokenKind::Parameter => 4,
        TokenKind::Function => 5,
        TokenKind::Method => 6,
        TokenKind::Property => 7,
        TokenKind::Type => 8,
        TokenKind::TypeParameter => 9,
        TokenKind::Namespace => 10,
        // a kind this server doesn't know yet
        _ => 3,
    }
}

thread_local! {
    /// Globals every engine starts with (`print`, `math`, ...).
    static BUILTINS: HashSet<String> = rhue::Engine::new()
        .analyze("", None)
        .globals
        .into_iter()
        .map(|(n, _)| n)
        .collect();
}

/// The document's tokens, encoded how LSP wants them: each relative to the one
/// before, one line at a time (a long string gets split per line).
#[expect(
    clippy::cast_possible_truncation,
    reason = "lengths in a source, capped at 4 GiB by the lexer"
)]
pub fn semantic_tokens(text: &str) -> SemanticTokens {
    let idx = LineIndex::new(text);
    let outline = rhue::outline(text);
    let mut data = Vec::with_capacity(outline.tokens.len());
    let (mut prev_line, mut prev_col) = (0u32, 0u32);
    BUILTINS.with(|builtins| {
        for t in &outline.tokens {
            let mut mods = 0;
            if t.declaration {
                mods |= 1;
            }
            let word = &text[t.span.start as usize..t.span.end as usize];
            if t.global && builtins.contains(word) {
                mods |= 2;
            }
            // one piece per line
            let mut start = t.span.start as usize;
            for piece in word.split_inclusive('\n') {
                let content = piece.trim_end_matches(['\n', '\r']);
                let len: u32 = content.encode_utf16().count() as u32;
                if len > 0 {
                    let pos = idx.position(start);
                    let delta_line = pos.line - prev_line;
                    let delta_start = if delta_line == 0 {
                        pos.character - prev_col
                    } else {
                        pos.character
                    };
                    data.push(SemanticToken {
                        delta_line,
                        delta_start,
                        length: len,
                        token_type: type_index(t.kind),
                        token_modifiers_bitset: mods,
                    });
                    prev_line = pos.line;
                    prev_col = pos.character;
                }
                start += piece.len();
            }
        }
    });
    SemanticTokens {
        result_id: None,
        data,
    }
}
