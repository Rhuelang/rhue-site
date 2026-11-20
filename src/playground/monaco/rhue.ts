// ─ Rhue in Monaco ────────────────────────────────────────────────────────────
// the grammar is just for colour while the language worker catches up, the real
// stuff (types, completion, rename...) all comes from rhue-lsp through LangClient

import * as monaco from "./editor";
import type { LangClient, Legend } from "../wasm";

export const LANG = "rhue";
export const ROOT = "file:///play/";

export const uriOf = (path: string) => monaco.Uri.parse(ROOT + path);
export const pathOf = (uri: monaco.Uri | string) => {
  const s = typeof uri === "string" ? uri : uri.toString();
  return s.startsWith(ROOT) ? decodeURIComponent(s.slice(ROOT.length)) : s;
};

// ─ Grammar ───────────────────────────────────────────────────────────────────

const grammar: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".rhue",
  keywords: [
    "and", "break", "continue", "do", "else", "elseif", "end", "for", "function", "if", "in",
    "local", "not", "or", "repeat", "return", "then", "until", "while", "export",
  ],
  constants: ["true", "false", "nil"],
  types: ["number", "string", "boolean", "any", "never", "unknown", "thread", "buffer", "vector", "userdata"],
  builtins: [
    "print", "type", "typeof", "tostring", "tonumber", "error", "assert", "select", "rawequal", "rawget",
    "rawset", "rawlen", "setmetatable", "getmetatable", "unpack", "collectgarbage", "pcall", "xpcall",
    "next", "pairs", "ipairs", "require", "self",
  ],
  libraries: ["table", "string", "math", "coroutine", "os", "utf8", "bit32", "buffer", "debug", "vector", "task"],
  operators: [
    "+", "-", "*", "/", "//", "%", "^", "#", "==", "~=", "<=", ">=", "<", ">", "=", "..",
    "+=", "-=", "*=", "/=", "//=", "%=", "^=", "..=", "->", "::", "...", "?", "|", "&",
  ],
  symbols: /[=><~?:&|+\-*/^%#.]+/,
  escapes: /\\(?:[abfnrtvz\\"'`{}\n]|x[0-9A-Fa-f]{2}|\d{1,3}|u\{[0-9A-Fa-f]+\})/,
  tokenizer: {
    root: [
      // a type annotation's name after "type X =" or a ":" gets its own colour
      [/(type)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "type.identifier"]],
      [/[A-Za-z_]\w*(?=\s*[({"'`]|\s*\[\[)/, {
        cases: { "@keywords": "keyword", "@constants": "constant", "@builtins": "predefined", "@default": "function" },
      }],
      [/[A-Za-z_]\w*/, {
        cases: {
          "@keywords": "keyword",
          "@constants": "constant",
          "@types": "type",
          "@libraries": "namespace",
          "@builtins": "predefined",
          "type": "keyword",
          "@default": "identifier",
        },
      }],
      { include: "@whitespace" },
      [/[{}()[\]]/, "@brackets"],
      [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[bB][01_]+/, "number.binary"],
      [/\d[\d_]*(\.[\d_]*)?([eE][-+]?\d+)?/, "number"],
      [/\.\d[\d_]*([eE][-+]?\d+)?/, "number"],
      [/[;,.]/, "delimiter"],
      [/\[(=*)\[/, { token: "string.long", next: "@longString.$1" }],
      [/"/, { token: "string.quote", next: "@string.\"" }],
      [/'/, { token: "string.quote", next: "@string.'" }],
      [/`/, { token: "string.quote", next: "@interp" }],
    ],
    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/--!\w+/, "comment.directive"],
      [/--\[(=*)\[/, { token: "comment", next: "@longComment.$1" }],
      [/--.*$/, "comment"],
    ],
    longComment: [
      [/\](=*)\]/, { cases: { "$1==$S2": { token: "comment", next: "@pop" }, "@default": "comment" } }],
      [/./, "comment"],
    ],
    longString: [
      [/\](=*)\]/, { cases: { "$1==$S2": { token: "string.long", next: "@pop" }, "@default": "string.long" } }],
      [/./, "string.long"],
    ],
    string: [
      [/[^\\"']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/["']/, { cases: { "$#==$S2": { token: "string.quote", next: "@pop" }, "@default": "string" } }],
    ],
    interp: [
      [/[^\\`{]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\{/, { token: "delimiter.bracket.interp", next: "@interpExpr" }],
      [/`/, { token: "string.quote", next: "@pop" }],
    ],
    interpExpr: [
      [/\}/, { token: "delimiter.bracket.interp", next: "@pop" }],
      { include: "root" },
    ],
  },
};

const config: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "--", blockComment: ["--[[", "]]"] },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
    { open: "`", close: "`", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
    { open: '"', close: '"' }, { open: "'", close: "'" }, { open: "`", close: "`" },
  ],
  indentationRules: {
    increaseIndentPattern: /^((?!--).)*(\b(function|then|do|repeat|else)\b((?!\bend\b).)*|\{[^}"']*|\([^)"']*)$/,
    decreaseIndentPattern: /^\s*((\b(elseif|else|end|until)\b)|(\})|(\)))/,
  },
  onEnterRules: [],
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  folding: { markers: { start: /^\s*--\s*#region\b/, end: /^\s*--\s*#endregion\b/ } },
};

// ─ LSP shapes into Monaco shapes ─────────────────────────────────────────────

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };

export const toRange = (r: LspRange) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

const COMPLETION_KINDS: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text, 2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function, 4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field, 6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class, 8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module, 10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit, 12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum, 14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet, 16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File, 18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder, 20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant, 22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event, 24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

const markdown = (c: any): monaco.IMarkdownString[] => {
  if (!c) return [];
  if (typeof c === "string") return [{ value: c }];
  if (Array.isArray(c)) return c.flatMap(markdown);
  if ("kind" in c) return [{ value: c.value }];
  if ("language" in c) return [{ value: "```" + c.language + "\n" + c.value + "\n```" }];
  return [];
};

const doc = (d: any) => (d == null ? undefined : typeof d === "string" ? d : { value: d.value });

function workspaceEdit(edit: any): monaco.languages.WorkspaceEdit {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, list] of Object.entries<any[]>(edit?.changes ?? {})) {
    for (const e of list) edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
  }
  for (const dc of edit?.documentChanges ?? []) {
    for (const e of dc.edits ?? []) edits.push({ resource: monaco.Uri.parse(dc.textDocument.uri), versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
  }
  return { edits };
}

export function toMarkers(diags: any[]): monaco.editor.IMarkerData[] {
  return diags.map((d) => {
    const r = toRange(d.range);
    return {
      severity: SEVERITY[d.severity] ?? monaco.MarkerSeverity.Error,
      message: d.message,
      source: d.source ?? "rhue",
      code: d.code != null ? String(d.code) : undefined,
      startLineNumber: r.startLineNumber,
      startColumn: r.startColumn,
      endLineNumber: r.endLineNumber,
      endColumn: Math.max(r.endColumn, r.startLineNumber === r.endLineNumber ? r.startColumn + 1 : r.endColumn),
      tags: d.tags,
    };
  });
}

// ─ Registration ──────────────────────────────────────────────────────────────

let registered = false;

export function registerRhue(lang: LangClient, legend: Legend) {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: LANG, extensions: [".rhue"], aliases: ["Rhue", "rhue"] });
  monaco.languages.setMonarchTokensProvider(LANG, grammar);
  monaco.languages.setLanguageConfiguration(LANG, config);

  const at = (model: monaco.editor.ITextModel, p: monaco.Position) => [pathOf(model.uri), p.lineNumber - 1, p.column - 1] as const;

  monaco.languages.registerHoverProvider(LANG, {
    async provideHover(model, p) {
      const h = await lang.hover(...at(model, p));
      if (!h) return null;
      return { contents: markdown(h.contents), range: h.range ? toRange(h.range) : undefined };
    },
  });

  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: [".", ":"],
    async provideCompletionItems(model, p) {
      const items = await lang.completion(...at(model, p));
      const word = model.getWordUntilPosition(p);
      const range = new monaco.Range(p.lineNumber, word.startColumn, p.lineNumber, word.endColumn);
      return {
        suggestions: items.map((it: any) => ({
          label: it.label,
          kind: COMPLETION_KINDS[it.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: it.detail,
          documentation: doc(it.documentation),
          insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: it.textEdit?.range ? toRange(it.textEdit.range) : range,
          sortText: it.sortText,
          filterText: it.filterText,
        })),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANG, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, p) {
      const s = await lang.signatureHelp(...at(model, p));
      if (!s?.signatures?.length) return null;
      return {
        value: {
          signatures: s.signatures.map((sig: any) => ({
            label: sig.label,
            documentation: doc(sig.documentation),
            parameters: (sig.parameters ?? []).map((pa: any) => ({ label: pa.label, documentation: doc(pa.documentation) })),
            activeParameter: sig.activeParameter,
          })),
          activeSignature: s.activeSignature ?? 0,
          activeParameter: s.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDefinitionProvider(LANG, {
    async provideDefinition(model, p) {
      const loc = await lang.definition(...at(model, p));
      if (!loc) return null;
      const list = Array.isArray(loc) ? loc : [loc];
      return list.map((l: any) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    },
  });

  monaco.languages.registerReferenceProvider(LANG, {
    async provideReferences(model, p) {
      const locs = await lang.references(...at(model, p));
      return locs.map((l: any) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    },
  });

  monaco.languages.registerRenameProvider(LANG, {
    async provideRenameEdits(model, p, newName) {
      try {
        return workspaceEdit(await lang.rename(...at(model, p), newName));
      } catch (e) {
        return { edits: [], rejectReason: (e as Error).message };
      }
    },
    async resolveRenameLocation(model, p) {
      const r = await lang.prepareRename(...at(model, p));
      if (!r) return { range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: "", rejectReason: "Only locals can be renamed" };
      const range = toRange(r.range ?? r);
      return { range, text: model.getValueInRange(range) };
    },
  });

  monaco.languages.registerInlayHintsProvider(LANG, {
    async provideInlayHints(model, range) {
      const hints = await lang.inlayHints(pathOf(model.uri), range.startLineNumber - 1, range.endLineNumber - 1);
      return {
        hints: hints.map((h: any) => ({
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          label: typeof h.label === "string" ? h.label : h.label.map((part: any) => part.value).join(""),
          kind: h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
          textEdits: h.textEdits?.map((e: any) => ({ range: toRange(e.range), text: e.newText })),
        })),
        dispose() {},
      };
    },
  });

  monaco.languages.registerCodeActionProvider(LANG, {
    async provideCodeActions(model, range, context) {
      const list = await lang.codeActions(pathOf(model.uri), range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1);
      const actions = list
        .filter((a: any) => a.edit)
        .map((a: any) => ({
          title: a.title,
          kind: a.kind ?? "quickfix",
          isPreferred: a.isPreferred,
          edit: workspaceEdit(a.edit),
          diagnostics: context.markers.filter((m) => a.diagnostics?.some((d: any) => d.message === m.message)),
        }));
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ["quickfix"] });

  monaco.languages.registerDocumentSemanticTokensProvider(LANG, {
    getLegend: () => ({ tokenTypes: legend.types, tokenModifiers: legend.modifiers }),
    async provideDocumentSemanticTokens(model) {
      const t = await lang.semanticTokens(pathOf(model.uri));
      return t ? { data: new Uint32Array(t.data) } : null;
    },
    releaseDocumentSemanticTokens() {},
  });

  monaco.languages.registerDocumentSymbolProvider(LANG, {
    displayName: "Rhue",
    async provideDocumentSymbols(model) {
      return (await lang.symbols(pathOf(model.uri))).map(toSymbol);
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(LANG, {
    displayName: "rhue fmt",
    async provideDocumentFormattingEdits(model) {
      const edits = await lang.format(pathOf(model.uri));
      return (edits ?? []).map((e: any) => ({ range: toRange(e.range), text: e.newText }));
    },
  });
}

export function toSymbol(s: any): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? "",
    kind: (s.kind ?? 13) - 1,
    tags: [],
    range: toRange(s.range),
    selectionRange: toRange(s.selectionRange),
    children: (s.children ?? []).map(toSymbol),
  };
}

// ─ Theme ─────────────────────────────────────────────────────────────────────
// built from the Aalto tokens on the page, so it's the same palette as every
// other code block on the site and flips with the theme toggle

function hex(name: string, el = document.documentElement) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v.startsWith("#") ? v : "#000000";
}

/** #rgb(a) without the alpha, for token rules */
const solid = (c: string) => c.replace("#", "").slice(0, 6);

export function applyTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  const c = (n: string) => hex(`--${n}`);
  const t = {
    keyword: solid(c("text-brand")),
    string: solid(c("link")),
    number: solid(c("text-gold")),
    comment: solid(c("text-subtle")),
    type: solid(c("text-accent")),
    fn: solid(dark ? "#ffbf7e" : "#904437"),
    text: solid(c("text-default")),
    subtle: solid(c("text-subtle")),
    strong: solid(c("text-strong")),
  };
  monaco.editor.defineTheme("aalto", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: t.text },
      { token: "keyword", foreground: t.keyword },
      { token: "constant", foreground: t.number },
      { token: "number", foreground: t.number },
      { token: "string", foreground: t.string },
      { token: "string.escape", foreground: t.type },
      { token: "delimiter.bracket.interp", foreground: t.keyword },
      { token: "comment", foreground: t.comment, fontStyle: "italic" },
      { token: "comment.directive", foreground: t.type, fontStyle: "bold" },
      { token: "type", foreground: t.type },
      { token: "type.identifier", foreground: t.type },
      { token: "namespace", foreground: t.type },
      { token: "predefined", foreground: t.fn },
      { token: "function", foreground: t.fn },
      { token: "operator", foreground: t.subtle },
      { token: "delimiter", foreground: t.subtle },
      // semantic tokens
      { token: "variable", foreground: t.text },
      { token: "parameter", foreground: t.text, fontStyle: "italic" },
      { token: "property", foreground: t.text },
      { token: "method", foreground: t.fn },
      { token: "function.defaultLibrary", foreground: t.fn },
      { token: "variable.defaultLibrary", foreground: t.type },
      { token: "namespace.defaultLibrary", foreground: t.type },
      { token: "typeParameter", foreground: t.type, fontStyle: "italic" },
      { token: "enumMember", foreground: t.number },
      { token: "variable.readonly", foreground: t.strong },
    ],
    colors: {
      "editor.background": c("base"),
      "editor.foreground": c("text-default"),
      "editorLineNumber.foreground": c("text-inactive"),
      "editorLineNumber.activeForeground": c("text-subtle"),
      "editor.lineHighlightBackground": c("tint") + (dark ? "66" : "99"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": c("brand-tint").slice(0, 7) + (dark ? "66" : "40"),
      "editor.inactiveSelectionBackground": c("brand-tint").slice(0, 7) + "30",
      "editor.wordHighlightBackground": c("accent-tint"),
      "editor.findMatchBackground": c("gold-tint"),
      "editor.findMatchHighlightBackground": c("gold-tint"),
      "editorCursor.foreground": c("text-brand"),
      "editorWhitespace.foreground": c("fill"),
      "editorIndentGuide.background1": c("hairline"),
      "editorIndentGuide.activeBackground1": c("line-strong"),
      "editorBracketMatch.background": c("accent-tint"),
      "editorBracketMatch.border": "#00000000",
      "editorGutter.background": c("base"),
      "editorWidget.background": c("overlay"),
      "editorWidget.border": c("line"),
      "editorHoverWidget.background": c("overlay"),
      "editorHoverWidget.border": c("line"),
      "editorSuggestWidget.background": c("overlay"),
      "editorSuggestWidget.border": c("line"),
      "editorSuggestWidget.selectedBackground": c("brand-tint"),
      "editorSuggestWidget.highlightForeground": c("text-brand"),
      "editorSuggestWidget.focusHighlightForeground": c("text-brand"),
      "list.hoverBackground": c("fill"),
      "list.activeSelectionBackground": c("brand-tint"),
      "list.activeSelectionForeground": c("text-strong"),
      "list.focusBackground": c("brand-tint"),
      "list.highlightForeground": c("text-brand"),
      "quickInput.background": c("overlay"),
      "quickInputList.focusBackground": c("brand-tint"),
      "input.background": c("control"),
      "input.border": c("line"),
      "focusBorder": c("brand"),
      "peekView.border": c("brand"),
      "peekViewEditor.background": c("recessed"),
      "peekViewResult.background": c("elevated"),
      "peekViewTitle.background": c("elevated"),
      "editorError.foreground": c("danger"),
      "editorWarning.foreground": c("gold"),
      "editorInfo.foreground": c("accent"),
      "editorInlayHint.foreground": c("text-subtle"),
      "editorInlayHint.background": c("fill") + "99",
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": c("line-strong") + "55",
      "scrollbarSlider.hoverBackground": c("line-strong") + "88",
      "scrollbarSlider.activeBackground": c("line-strong") + "aa",
      "minimap.background": c("base"),
      "editorStickyScroll.background": c("base"),
      "editorStickyScrollHover.background": c("tint"),
      "widget.shadow": "#00000040",
    },
  });
  monaco.editor.setTheme("aalto");
}
