// ─ Language service ──────────────────────────────────────────────────────────
// rhue-lsp's functions, minus the server. files live in memory under /play,
// so require("util") finds util.rhue next to main.rhue like it would on disk

use lsp_types::{Position, Range, Uri};
use rhue::{CompileOptions, Engine, TypeMode};
use rhue_lsp::Docs;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

const ROOT: &str = "/play/";

fn uri(path: &str) -> Uri {
    rhue_lsp::uri::from_file_path(format!("{ROOT}{path}")).expect("playground paths are absolute")
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn pos(line: u32, character: u32) -> Position {
    Position { line, character }
}

#[derive(Deserialize)]
struct HostDecl {
    name: String,
    #[serde(rename = "type")]
    ty: String,
}

#[wasm_bindgen]
pub struct Lang {
    docs: Docs,
    host: Vec<HostDecl>,
    mode: TypeMode,
}

#[wasm_bindgen]
impl Lang {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Lang {
        Lang {
            docs: Docs::default(),
            host: Vec::new(),
            mode: TypeMode::NonStrict,
        }
    }

    pub fn set_file(&mut self, path: &str, text: String) {
        self.docs.set_text(&uri(path), text);
    }

    pub fn remove_file(&mut self, path: &str) {
        self.docs.close(&uri(path));
    }

    /// Globals host.js adds, `[{ name, type }]`. Every engine gets thrown out
    /// since anything could've been checked against the old ones
    pub fn set_host(&mut self, decls: &str) -> Result<(), JsError> {
        self.host = serde_json::from_str(decls)?;
        self.reset();
        Ok(())
    }

    /// What unannotated files get checked as (the editor's checker always uses
    /// at least nonstrict, same as rhue-lsp, so this only matters for strict)
    pub fn set_mode(&mut self, mode: &str) {
        self.mode = parse_mode(mode);
        self.reset();
    }

    fn reset(&mut self) {
        let open = std::mem::take(&mut self.docs.open);
        self.docs = Docs::default();
        for (u, t) in open {
            self.docs.set_text(&u, t);
        }
    }

    // the engine docs made for this file, with host.js's globals declared on it
    fn prep(&self, path: &str) -> Option<(Uri, String)> {
        let u = uri(path);
        let text = self.docs.open.get(&u)?.clone();
        let mut engine = self.docs.engine_for(&u);
        // the run panel's engines have the task library, so the checker should know it
        engine.open_tasks();
        if self.mode == TypeMode::Strict {
            engine.set_default_type_mode(TypeMode::Strict);
        }
        for d in &self.host {
            if engine.global_type(&d.name).is_none() {
                // a bad type shows up when host.js gets applied, not here
                let _ = engine.declare(&d.name, &d.ty);
            }
        }
        drop(engine);
        Some((u, text))
    }

    pub fn diagnostics(&self, path: &str) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        json(&rhue_lsp::diagnostics(&self.docs, &u, &text))
    }

    pub fn hover(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "null".into();
        };
        json(&rhue_lsp::hover(&self.docs, &u, &text, pos(line, col)))
    }

    pub fn completion(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        json(&rhue_lsp::completion(&self.docs, &u, &text, pos(line, col)))
    }

    pub fn signature_help(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "null".into();
        };
        json(&rhue_lsp::signature_help(
            &self.docs,
            &u,
            &text,
            pos(line, col),
        ))
    }

    pub fn definition(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "null".into();
        };
        json(&rhue_lsp::definition(&self.docs, &u, &text, pos(line, col)))
    }

    pub fn references(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        json(&rhue_lsp::references(&self.docs, &u, &text, pos(line, col)))
    }

    pub fn prepare_rename(&self, path: &str, line: u32, col: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "null".into();
        };
        json(&rhue_lsp::prepare_rename(
            &self.docs,
            &u,
            &text,
            pos(line, col),
        ))
    }

    pub fn rename(&self, path: &str, line: u32, col: u32, name: &str) -> Result<String, JsError> {
        let Some((u, text)) = self.prep(path) else {
            return Ok("null".into());
        };
        rhue_lsp::rename(&self.docs, &u, &text, pos(line, col), name)
            .map(|edit| json(&edit))
            .map_err(|e| JsError::new(&e))
    }

    pub fn inlay_hints(&self, path: &str, from: u32, to: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        let range = Range {
            start: pos(from, 0),
            end: pos(to, u32::MAX),
        };
        json(&rhue_lsp::inlay_hints(&self.docs, &u, &text, range))
    }

    pub fn code_actions(&self, path: &str, sl: u32, sc: u32, el: u32, ec: u32) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        let range = Range {
            start: pos(sl, sc),
            end: pos(el, ec),
        };
        json(&rhue_lsp::code_actions(&self.docs, &u, &text, range))
    }

    pub fn semantic_tokens(&self, path: &str) -> String {
        let Some(text) = self.docs.open.get(&uri(path)) else {
            return "null".into();
        };
        json(&rhue_lsp::semantic_tokens(text))
    }

    pub fn symbols(&self, path: &str) -> String {
        let Some((u, text)) = self.prep(path) else {
            return "[]".into();
        };
        json(&rhue_lsp::document_symbols(&self.docs, &u, &text))
    }

    pub fn format(&self, path: &str) -> String {
        let Some(text) = self.docs.open.get(&uri(path)) else {
            return "null".into();
        };
        json(&rhue_lsp::formatting(text, true, 4))
    }

    /// The bytecode `path` compiles to, the way the run panel would build it
    pub fn disassemble(&self, path: &str, fold_constants: bool) -> String {
        let Some(text) = self.docs.open.get(&uri(path)) else {
            return String::new();
        };
        let mut engine = Engine::with_options(CompileOptions::new().fold_constants(fold_constants));
        // the bytecode doesn't care about types, and a type error shouldn't hide it
        engine.set_default_type_mode(TypeMode::NoCheck);
        engine.open_tasks();
        for d in &self.host {
            let _ = engine.declare(&d.name, &d.ty);
        }
        match engine.compile(path, text) {
            Ok(chunk) => {
                let bytes = chunk.to_bytes().len();
                format!(
                    "-- {path}: {bytes} bytes serialized\n\n{}",
                    chunk.disassemble()
                )
            }
            Err(e) => format!("-- doesn't compile yet\n\n{}", e.render(false)),
        }
    }
}

impl Default for Lang {
    fn default() -> Self {
        Self::new()
    }
}

pub fn parse_mode(mode: &str) -> TypeMode {
    match mode {
        "strict" => TypeMode::Strict,
        "nocheck" => TypeMode::NoCheck,
        _ => TypeMode::NonStrict,
    }
}

/// The legend semantic_tokens uses, `{ types, modifiers }`
#[wasm_bindgen]
pub fn token_legend() -> String {
    let types: Vec<&str> = rhue_lsp::LEGEND_TYPES.iter().map(|t| t.as_str()).collect();
    let mods: Vec<&str> = rhue_lsp::LEGEND_MODIFIERS
        .iter()
        .map(|m| m.as_str())
        .collect();
    json(&serde_json::json!({ "types": types, "modifiers": mods }))
}

/// The rhue version this was built against (from Cargo.lock, see build.rs)
#[wasm_bindgen]
pub fn rhue_version() -> String {
    env!("RHUE_VERSION").into()
}
