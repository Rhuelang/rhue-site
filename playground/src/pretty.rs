// ─ Printing values ───────────────────────────────────────────────────────────
// what the console and the variables view show for a value

use rhue::{Context, Value};

/// luau's typeof
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Nil => "nil",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Function(_) => "function",
        Value::Table(_) => "table",
        Value::UserData(_) => "userdata",
        Value::Thread(_) => "thread",
        Value::Buffer(_) => "buffer",
        Value::Vector(_) => "vector",
        _ => "unknown",
    }
}

pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One line, tables a couple levels deep. `depth` is how far in it'll look
pub fn show(cx: &mut Context<'_>, v: &Value, depth: u32) -> String {
    match v {
        Value::String(s) => quote(s),
        Value::Table(t) => {
            if depth == 0 {
                return "{…}".into();
            }
            let pairs = cx.pairs(t);
            if pairs.is_empty() {
                return "{}".into();
            }
            let len = cx.len(t);
            let mut parts = Vec::new();
            // array part first, in order, without keys
            let mut seq = 0;
            if len > 0 {
                for i in 1..=len.min(16) {
                    let v = pairs
                        .iter()
                        .find(|(k, _)| matches!(k, Value::Number(n) if *n == i as f64))
                        .map(|(_, v)| v.clone())
                        .unwrap_or(Value::Nil);
                    parts.push(show(cx, &v, depth - 1));
                    seq = i;
                }
            }
            let mut rest: Vec<(Value, Value)> = pairs
                .into_iter()
                .filter(|(k, _)| !matches!(k, Value::Number(n) if n.fract() == 0.0 && *n >= 1.0 && *n <= len as f64))
                .collect();
            rest.sort_by_key(|(k, _)| key_text(k));
            let shown = 16usize.saturating_sub(parts.len());
            let more = rest.len().saturating_sub(shown) + len.saturating_sub(seq);
            for (k, v) in rest.into_iter().take(shown) {
                let k = match &k {
                    Value::String(s) if is_name(s) => s.to_string(),
                    other => format!("[{}]", show(cx, other, 0)),
                };
                parts.push(format!("{k} = {}", show(cx, &v, depth - 1)));
            }
            if more > 0 {
                parts.push(format!("… {more} more"));
            }
            format!("{{ {} }}", parts.join(", "))
        }
        Value::Buffer(b) => format!("buffer({} bytes)", cx.buffer_bytes(b).len()),
        other => other.to_string(),
    }
}

pub fn key_text(k: &Value) -> String {
    match k {
        Value::String(s) => format!("1{s}"),
        Value::Number(n) => format!("0{n:020.6}"),
        other => format!("2{other}"),
    }
}

pub fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        && !matches!(
            s,
            "and"
                | "break"
                | "do"
                | "else"
                | "elseif"
                | "end"
                | "false"
                | "for"
                | "function"
                | "if"
                | "in"
                | "local"
                | "nil"
                | "not"
                | "or"
                | "repeat"
                | "return"
                | "then"
                | "true"
                | "until"
                | "while"
        )
}
