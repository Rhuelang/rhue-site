// ─ Positions ─────────────────────────────────────────────────────────────────
// rhue spans are byte offsets, the editor wants lines and utf-16 columns

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pos {
    pub line: u32,
    pub col: u32,
}

pub fn position(text: &str, offset: usize) -> Pos {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &text[..offset];
    let line = before.bytes().filter(|&b| b == b'\n').count();
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    Pos {
        line: u32::try_from(line).unwrap_or(u32::MAX),
        col: u32::try_from(before[start..].encode_utf16().count()).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns() {
        let t = "a = 1\nlocal é = \"🐺\" x";
        assert_eq!(position(t, 0), Pos { line: 0, col: 0 });
        assert_eq!(position(t, 6), Pos { line: 1, col: 0 });
        // é is 2 bytes, 1 utf-16 unit. the wolf is 4 bytes, 2 units
        let x = t.find('x').unwrap();
        assert_eq!(position(t, x), Pos { line: 1, col: 15 });
    }
}
