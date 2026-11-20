//! `rhue-lsp`, a language server for Rhue over stdio.
//!
//! Point your editor's LSP client at the `rhue-lsp` binary for `*.rhue` files.
//! You get diagnostics as you type (with quick fixes), hover types, inlay
//! hints, go to definition and find references (locals, and module fields
//! across the workspace), document and workspace symbols, semantic
//! highlighting, completion (after `.` and `:`, and names in scope), renaming
//! locals, signature help and formatting.

use rhue_lsp::uri::UriExt;
use std::error::Error;

use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use lsp_types::notification::{
    DidChangeTextDocument, DidChangeWatchedFiles, DidCloseTextDocument, DidOpenTextDocument,
    DidSaveTextDocument, Notification as _, PublishDiagnostics,
};
use lsp_types::request::{
    CodeActionRequest, Completion, DocumentSymbolRequest, Formatting, GotoDefinition, HoverRequest,
    InlayHintRequest, PrepareRenameRequest, References, Rename, Request as _,
    SemanticTokensFullRequest, SignatureHelpRequest, WorkspaceSymbolRequest,
};
use lsp_types::{
    CodeActionKind, CodeActionOptions, CodeActionParams, CodeActionProviderCapability,
    DocumentSymbolParams, DocumentSymbolResponse, InitializeParams, InlayHintParams,
    SemanticTokensFullOptions, SemanticTokensLegend, SemanticTokensOptions, SemanticTokensParams,
    SemanticTokensResult, SemanticTokensServerCapabilities, WorkspaceSymbolParams,
    WorkspaceSymbolResponse,
};
use lsp_types::{
    CompletionOptions, CompletionParams, CompletionResponse, DocumentFormattingParams,
    GotoDefinitionParams, GotoDefinitionResponse, HoverParams, HoverProviderCapability, OneOf,
    PrepareRenameResponse, PublishDiagnosticsParams, ReferenceParams, RenameOptions, RenameParams,
    ServerCapabilities, SignatureHelpOptions, SignatureHelpParams, TextDocumentPositionParams,
    TextDocumentSyncCapability, TextDocumentSyncKind, TextDocumentSyncOptions,
    TextDocumentSyncSaveOptions, Uri,
};
use rhue_lsp::Docs;

fn main() -> Result<(), Box<dyn Error + Sync + Send>> {
    let (connection, io_threads) = Connection::stdio();
    let capabilities = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Options(
            TextDocumentSyncOptions {
                open_close: Some(true),
                change: Some(TextDocumentSyncKind::INCREMENTAL),
                save: Some(TextDocumentSyncSaveOptions::Supported(true)),
                ..TextDocumentSyncOptions::default()
            },
        )),
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        definition_provider: Some(OneOf::Left(true)),
        references_provider: Some(OneOf::Left(true)),
        document_formatting_provider: Some(OneOf::Left(true)),
        completion_provider: Some(CompletionOptions {
            trigger_characters: Some(vec![".".into(), ":".into()]),
            ..CompletionOptions::default()
        }),
        rename_provider: Some(OneOf::Right(RenameOptions {
            prepare_provider: Some(true),
            work_done_progress_options: Default::default(),
        })),
        signature_help_provider: Some(SignatureHelpOptions {
            trigger_characters: Some(vec!["(".into(), ",".into()]),
            ..SignatureHelpOptions::default()
        }),
        inlay_hint_provider: Some(OneOf::Left(true)),
        document_symbol_provider: Some(OneOf::Left(true)),
        workspace_symbol_provider: Some(OneOf::Left(true)),
        code_action_provider: Some(CodeActionProviderCapability::Options(CodeActionOptions {
            code_action_kinds: Some(vec![
                CodeActionKind::QUICKFIX,
                CodeActionKind::REFACTOR_REWRITE,
            ]),
            ..CodeActionOptions::default()
        })),
        semantic_tokens_provider: Some(SemanticTokensServerCapabilities::SemanticTokensOptions(
            SemanticTokensOptions {
                legend: SemanticTokensLegend {
                    token_types: rhue_lsp::LEGEND_TYPES.to_vec(),
                    token_modifiers: rhue_lsp::LEGEND_MODIFIERS.to_vec(),
                },
                full: Some(SemanticTokensFullOptions::Bool(true)),
                range: None,
                ..SemanticTokensOptions::default()
            },
        )),
        ..ServerCapabilities::default()
    };
    let caps = serde_json::to_value(capabilities)?;
    let (id, params) = connection.initialize_start()?;
    let roots = workspace_roots(serde_json::from_value(params).ok());
    connection.initialize_finish(
        id,
        serde_json::json!({
            "capabilities": caps,
            "serverInfo": { "name": "rhue-lsp", "version": env!("CARGO_PKG_VERSION") },
        }),
    )?;
    serve(&connection, roots)?;
    // the writer thread finishes once the connection's gone
    drop(connection);
    io_threads.join()?;
    Ok(())
}

/// The workspace folders the editor opened (or its root).
fn workspace_roots(params: Option<InitializeParams>) -> Vec<std::path::PathBuf> {
    let Some(p) = params else {
        return Vec::new();
    };
    let mut roots: Vec<std::path::PathBuf> = p
        .workspace_folders
        .unwrap_or_default()
        .iter()
        .filter_map(|f| f.uri.to_file_path().ok())
        .collect();
    #[allow(deprecated)] // older clients only send `rootUri`
    if roots.is_empty()
        && let Some(root) = p.root_uri.and_then(|u| u.to_file_path().ok())
    {
        roots.push(root);
    }
    roots
}

fn serve(
    connection: &Connection,
    roots: Vec<std::path::PathBuf>,
) -> Result<(), Box<dyn Error + Sync + Send>> {
    let mut docs = Docs::default();
    docs.roots = roots;
    for msg in &connection.receiver {
        match msg {
            Message::Request(req) => {
                if connection.handle_shutdown(&req)? {
                    return Ok(());
                }
                let resp = handle_request(&docs, req);
                connection.sender.send(Message::Response(resp))?;
            }
            Message::Notification(n) => {
                for uri in handle_notification(&mut docs, n) {
                    publish(connection, &docs, uri)?;
                }
            }
            Message::Response(_) => {}
        }
    }
    Ok(())
}

fn publish(
    connection: &Connection,
    docs: &Docs,
    uri: Uri,
) -> Result<(), Box<dyn Error + Sync + Send>> {
    let diagnostics = match docs.open.get(&uri) {
        Some(text) => rhue_lsp::diagnostics(docs, &uri, text),
        None => Vec::new(),
    };
    let params = PublishDiagnosticsParams::new(uri, diagnostics, None);
    connection
        .sender
        .send(Message::Notification(Notification::new(
            PublishDiagnostics::METHOD.into(),
            params,
        )))?;
    Ok(())
}

/// Updates the open documents, returns the ones whose diagnostics might have
/// changed.
fn handle_notification(docs: &mut Docs, n: Notification) -> Vec<Uri> {
    match n.method.as_str() {
        DidOpenTextDocument::METHOD => {
            let Some(p): Option<lsp_types::DidOpenTextDocumentParams> =
                serde_json::from_value(n.params).ok()
            else {
                return Vec::new();
            };
            let uri = p.text_document.uri;
            let mut out = docs.set_text(&uri, p.text_document.text);
            out.insert(0, uri);
            out
        }
        DidChangeTextDocument::METHOD => {
            let Some(p): Option<lsp_types::DidChangeTextDocumentParams> =
                serde_json::from_value(n.params).ok()
            else {
                return Vec::new();
            };
            let uri = p.text_document.uri;
            let mut out = Vec::new();
            for change in p.content_changes {
                out.extend(docs.apply_change(&uri, change.range, &change.text));
            }
            out.sort();
            out.dedup();
            out.insert(0, uri);
            out
        }
        DidCloseTextDocument::METHOD => {
            let Some(p): Option<lsp_types::DidCloseTextDocumentParams> =
                serde_json::from_value(n.params).ok()
            else {
                return Vec::new();
            };
            let uri = p.text_document.uri;
            let mut out = docs.close(&uri);
            // clear the closed document's diagnostics
            out.insert(0, uri);
            out
        }
        DidSaveTextDocument::METHOD | DidChangeWatchedFiles::METHOD => docs.files_changed(),
        _ => Vec::new(),
    }
}

fn handle_request(docs: &Docs, req: Request) -> Response {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        HoverRequest::METHOD => params::<HoverParams>(req)
            .map(|p| {
                let tp = p.text_document_position_params;
                text(docs, &tp.text_document.uri)
                    .and_then(|t| rhue_lsp::hover(docs, &tp.text_document.uri, t, tp.position))
            })
            .map(json),
        GotoDefinition::METHOD => params::<GotoDefinitionParams>(req)
            .map(|p| {
                let tp = p.text_document_position_params;
                text(docs, &tp.text_document.uri)
                    .and_then(|t| rhue_lsp::definition(docs, &tp.text_document.uri, t, tp.position))
                    .map(GotoDefinitionResponse::Scalar)
            })
            .map(json),
        References::METHOD => params::<ReferenceParams>(req)
            .map(|p| {
                let tp = p.text_document_position;
                text(docs, &tp.text_document.uri)
                    .map(|t| rhue_lsp::references(docs, &tp.text_document.uri, t, tp.position))
            })
            .map(json),
        Completion::METHOD => params::<CompletionParams>(req)
            .map(|p| {
                let tp = p.text_document_position;
                text(docs, &tp.text_document.uri).map(|t| {
                    CompletionResponse::Array(rhue_lsp::completion(
                        docs,
                        &tp.text_document.uri,
                        t,
                        tp.position,
                    ))
                })
            })
            .map(json),
        PrepareRenameRequest::METHOD => params::<TextDocumentPositionParams>(req)
            .map(|tp| {
                text(docs, &tp.text_document.uri)
                    .and_then(|t| {
                        rhue_lsp::prepare_rename(docs, &tp.text_document.uri, t, tp.position)
                    })
                    .map(PrepareRenameResponse::Range)
            })
            .map(json),
        Rename::METHOD => match params::<RenameParams>(req) {
            Ok(p) => {
                let tp = p.text_document_position;
                let uri = tp.text_document.uri;
                match text(docs, &uri)
                    .ok_or_else(|| "the document isn't open".to_string())
                    .and_then(|t| rhue_lsp::rename(docs, &uri, t, tp.position, &p.new_name))
                {
                    Ok(edit) => Ok(json(edit)),
                    Err(e) => {
                        return Response::new_err(
                            id,
                            lsp_server::ErrorCode::RequestFailed as i32,
                            e,
                        );
                    }
                }
            }
            Err(e) => Err(e),
        },
        SignatureHelpRequest::METHOD => params::<SignatureHelpParams>(req)
            .map(|p| {
                let tp = p.text_document_position_params;
                text(docs, &tp.text_document.uri).and_then(|t| {
                    rhue_lsp::signature_help(docs, &tp.text_document.uri, t, tp.position)
                })
            })
            .map(json),
        Formatting::METHOD => params::<DocumentFormattingParams>(req)
            .map(|p| {
                text(docs, &p.text_document.uri).and_then(|t| {
                    rhue_lsp::formatting(t, p.options.insert_spaces, p.options.tab_size)
                })
            })
            .map(json),
        InlayHintRequest::METHOD => params::<InlayHintParams>(req)
            .map(|p| {
                let uri = p.text_document.uri;
                text(docs, &uri).map(|t| rhue_lsp::inlay_hints(docs, &uri, t, p.range))
            })
            .map(json),
        DocumentSymbolRequest::METHOD => params::<DocumentSymbolParams>(req)
            .map(|p| {
                let uri = p.text_document.uri;
                text(docs, &uri).map(|t| {
                    DocumentSymbolResponse::Nested(rhue_lsp::document_symbols(docs, &uri, t))
                })
            })
            .map(json),
        WorkspaceSymbolRequest::METHOD => params::<WorkspaceSymbolParams>(req)
            .map(|p| WorkspaceSymbolResponse::Flat(rhue_lsp::workspace_symbols(docs, &p.query)))
            .map(json),
        SemanticTokensFullRequest::METHOD => params::<SemanticTokensParams>(req)
            .map(|p| {
                text(docs, &p.text_document.uri)
                    .map(|t| SemanticTokensResult::Tokens(rhue_lsp::semantic_tokens(t)))
            })
            .map(json),
        CodeActionRequest::METHOD => params::<CodeActionParams>(req)
            .map(|p| {
                let uri = p.text_document.uri;
                text(docs, &uri).map(|t| rhue_lsp::code_actions(docs, &uri, t, p.range))
            })
            .map(json),
        _ => {
            return Response::new_err(
                id,
                lsp_server::ErrorCode::MethodNotFound as i32,
                format!("unsupported request {}", req.method),
            );
        }
    };
    match result {
        Ok(value) => Response::new_ok(id, value),
        Err(e) => invalid(id, e),
    }
}

fn text<'a>(docs: &'a Docs, uri: &Uri) -> Option<&'a str> {
    docs.open.get(uri).map(String::as_str)
}

fn params<P: serde::de::DeserializeOwned>(req: Request) -> Result<P, String> {
    serde_json::from_value(req.params).map_err(|e| e.to_string())
}

fn json<T: serde::Serialize>(v: T) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
}

fn invalid(id: RequestId, message: String) -> Response {
    Response::new_err(id, lsp_server::ErrorCode::InvalidParams as i32, message)
}
