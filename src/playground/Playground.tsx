// ─ Playground ────────────────────────────────────────────────────────────────
// a little VS Code for Rhue. the editor is monaco, everything it knows about
// the code comes from rhue-lsp in a worker, and runs happen in another worker
// that the debugger can actually pause

import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import * as monaco from "./monaco/editor";
import { applyTheme, LANG, pathOf, registerRhue, toMarkers, toSymbol, uriOf } from "./monaco/rhue";
import { LangClient } from "./wasm";
import { canDebug, readHost, Session, type Bp, type Mode, type Result, type RunError, type Scope, type Stopped, type Variable } from "./runner";
import { HOST_FILE, HOST_TEMPLATE, type HostDecl } from "./host";
import { asRust } from "./rust";
import { EXAMPLES, type Example } from "./examples";
import {
  addFile, closeFile, deleteFile, fromExample, fromLink, layout, MAIN, openFile, persist, previousWorkspace, removeBreakpoint,
  renameFile, replaceWorkspace, setFile, setLayout, setWs, shareLink, toggleBreakpoint, updateBreakpoint, ws,
} from "./store";
import { theme, useTitle } from "../lib/site";
import { Button, IconButton, SegmentedButton, Switch } from "../aalto";
import "./playground.css";

const RUST_TAB = "engine.rs";

// ─ Shared state ──────────────────────────────────────────────────────────────

type Line = { text: string; kind: "out" | "log" | "host" | "err" | "info" | "ok" | "echo" | "value"; time?: number };
type Problem = { file: string; line: number; col: number; message: string; severity: "error" | "warning" | "info" };

const [output, setOutput] = createSignal<Line[]>([]);
const [consoleLines, setConsoleLines] = createSignal<Line[]>([]);
const [problems, setProblems] = createSignal<Record<string, Problem[]>>({});
const [session, setSession] = createSignal<Session | undefined>();
const [status, setStatus] = createSignal<"idle" | "running" | "paused">("idle");
const [stopped, setStopped] = createSignal<Stopped | undefined>();
const [frame, setFrame] = createSignal(0);
const [scopes, setScopes] = createSignal<Scope[]>([]);
const [watchResults, setWatchResults] = createSignal<Record<string, Variable | string>>({});
const [lastResult, setLastResult] = createSignal<Result | undefined>();
const [hostDecls, setHostDecls] = createSignal<HostDecl[]>([]);
const [hostProblem, setHostProblem] = createSignal<string | undefined>();
const [version, setVersion] = createSignal("");
const [cursor, setCursor] = createSignal({ line: 1, col: 1 });
const [symbols, setSymbols] = createSignal<monaco.languages.DocumentSymbol[]>([]);
const [toast, setToast] = createSignal<{ text: string; action?: string; run?: () => void } | undefined>();
const [bpEditor, setBpEditor] = createSignal<{ path: string; line: number; x: number; y: number } | undefined>();

const MAX_LINES = 5000;
function push(set: typeof setOutput, ...lines: Line[]) {
  set((prev) => {
    const next = prev.concat(lines.map((l) => ({ time: Date.now(), ...l })));
    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  });
}
const out = (text: string, kind: Line["kind"] = "out") => push(setOutput, { text, kind });

let toastTimer = 0;
function notify(text: string, action?: string, run?: () => void) {
  setToast({ text, action, run });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(undefined), 5000);
}

const isRhue = (p: string) => p.endsWith(".rhue");
const fmtMs = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : ms < 1000 ? `${ms.toFixed(ms < 10 ? 2 : 1)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

// ─ Editor plumbing ───────────────────────────────────────────────────────────

const lang = new LangClient();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
const models = new Map<string, monaco.editor.ITextModel>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const bpDecorations = new Map<string, monaco.editor.IEditorDecorationsCollection>();
let stopDecorations: monaco.editor.IEditorDecorationsCollection | undefined;
let heatDecorations: monaco.editor.IEditorDecorationsCollection | undefined;
const heatByFile = new Map<string, monaco.editor.IModelDeltaDecoration[]>();
let hoverGlyph: monaco.editor.IEditorDecorationsCollection | undefined;

function languageOf(path: string) {
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".rs")) return "rust";
  return LANG;
}

function modelFor(path: string): monaco.editor.ITextModel {
  let m = models.get(path);
  if (m && !m.isDisposed()) return m;
  const text = path === RUST_TAB ? rustText() : ws.files[path] ?? "";
  m = monaco.editor.createModel(text, languageOf(path), uriOf(path));
  models.set(path, m);
  if (path !== RUST_TAB) {
    m.onDidChangeContent(() => {
      const text = m!.getValue();
      setFile(path, text);
      if (isRhue(path)) {
        void lang.setFile(path, text);
        scheduleCheck();
        scheduleBytecode();
        clearRunMarkers(path);
      }
      if (path === HOST_FILE) scheduleHost();
      syncBreakpointLines(path);
    });
  }
  return m;
}

function disposeModel(path: string) {
  models.get(path)?.dispose();
  models.delete(path);
  viewStates.delete(path);
  bpDecorations.delete(path);
}

// ─ Diagnostics ───────────────────────────────────────────────────────────────

let checkTimer = 0;
function scheduleCheck(delay = 220) {
  clearTimeout(checkTimer);
  checkTimer = window.setTimeout(checkAll, delay);
}

async function checkAll() {
  const next: Record<string, Problem[]> = {};
  for (const path of Object.keys(ws.files).filter(isRhue)) {
    const diags = await lang.diagnostics(path);
    const model = models.get(path) ?? modelFor(path);
    monaco.editor.setModelMarkers(model, "rhue", toMarkers(diags));
    next[path] = diags.map((d: any) => ({
      file: path,
      line: d.range.start.line + 1,
      col: d.range.start.character + 1,
      message: d.message,
      severity: d.severity === 2 ? "warning" : d.severity >= 3 ? "info" : "error",
    }));
  }
  const host = hostProblem();
  if (host) next[HOST_FILE] = [{ file: HOST_FILE, line: 1, col: 1, message: host, severity: "error" }];
  setProblems(next);
  refreshSymbols();
}

function clearRunMarkers(path: string) {
  const m = models.get(path);
  if (m) monaco.editor.setModelMarkers(m, "run", []);
}

function showRunError(e: RunError) {
  if (!e.file || !e.start) return;
  const m = modelFor(e.file);
  const end = e.end ?? e.start;
  monaco.editor.setModelMarkers(m, "run", [{
    severity: monaco.MarkerSeverity.Error,
    message: e.message,
    source: "runtime",
    startLineNumber: e.start.line + 1,
    startColumn: e.start.col + 1,
    endLineNumber: end.line + 1,
    endColumn: Math.max(end.col + 1, e.start.col + 2),
  }]);
}

async function refreshSymbols() {
  const path = ws.active;
  if (!isRhue(path)) return setSymbols([]);
  setSymbols((await lang.symbols(path)).map(toSymbol));
}

// ─ host.js ───────────────────────────────────────────────────────────────────

let hostTimer = 0;
function scheduleHost(delay = 450) {
  clearTimeout(hostTimer);
  hostTimer = window.setTimeout(refreshHost, delay);
}

async function refreshHost() {
  const src = ws.files[HOST_FILE];
  if (src == null || !ws.hostTrusted) {
    setHostDecls([]);
    setHostProblem(undefined);
  } else {
    const r = await readHost(src);
    setHostDecls(r.decls);
    setHostProblem(r.error);
  }
  await lang.setHost(hostDecls().filter((d) => d.type).map((d) => ({ name: d.name, type: d.type! })));
  refreshRust();
  scheduleCheck(0);
}

// ─ Bytecode ──────────────────────────────────────────────────────────────────

const [bytecode, setBytecode] = createSignal("");
let byteTimer = 0;
function scheduleBytecode(delay = 300) {
  clearTimeout(byteTimer);
  byteTimer = window.setTimeout(async () => {
    const path = isRhue(ws.active) ? ws.active : MAIN;
    setBytecode(await lang.disassemble(path, ws.settings.foldConstants));
  }, delay);
}

// ─ As Rust ───────────────────────────────────────────────────────────────────

const rustText = () => asRust(unwrap(ws.settings), hostDecls(), Object.keys(ws.files));
function refreshRust() {
  const m = models.get(RUST_TAB);
  if (m && !m.isDisposed()) m.setValue(rustText());
}

// ─ Breakpoints in the gutter ─────────────────────────────────────────────────

function bpClass(b: Bp) {
  const kind = b.log ? "log" : b.condition || b.hit ? "cond" : "plain";
  return `pg-bp pg-bp-${kind}${b.enabled ? "" : " pg-bp-off"}`;
}

function renderBreakpoints(path: string) {
  const m = models.get(path);
  if (!m || !editor || editor.getModel() !== m) return;
  const list = ws.breakpoints[path] ?? [];
  const decos = list
    .filter((b) => b.line <= m.getLineCount())
    .map<monaco.editor.IModelDeltaDecoration>((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        glyphMarginClassName: bpClass(b),
        glyphMarginHoverMessage: { value: b.log ? `Logpoint: \`${b.log}\`` : b.condition ? `Breaks when \`${b.condition}\`` : b.hit ? `Breaks on hit ${b.hit}` : "Breakpoint" },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
  let coll = bpDecorations.get(path);
  if (!coll) {
    coll = editor.createDecorationsCollection();
    bpDecorations.set(path, coll);
  }
  coll.set(decos);
}

// lines move when you type above them, the decorations follow and we copy that back
function syncBreakpointLines(path: string) {
  const coll = bpDecorations.get(path);
  const list = ws.breakpoints[path];
  if (!coll || !list?.length || editor?.getModel() !== models.get(path)) return;
  const lines = coll.getRanges().map((r) => r.startLineNumber);
  if (lines.length !== list.length) return;
  if (lines.some((l, i) => l !== list[i].line)) {
    setWs("breakpoints", path, list.map((b, i) => ({ ...b, line: lines[i] })));
    persist();
    session()?.setBreakpoints(unwrap(ws.breakpoints));
  }
}

// ─ Running ───────────────────────────────────────────────────────────────────

function runnableFiles() {
  return Object.entries(ws.files).filter(([p]) => isRhue(p)).map(([path, text]) => ({ path, text }));
}

function start(mode: Mode) {
  const cur = session();
  if (cur?.running) {
    if (mode === "debug" && status() === "paused") resume("continue");
    return;
  }
  if (mode === "debug" && !canDebug()) {
    notify("Debugging needs a cross-origin isolated page, this browser didn't give us one. Run and Profile still work.");
    return;
  }
  cur?.dispose();
  for (const p of models.keys()) clearRunMarkers(p);
  clearHeat();
  batch(() => {
    setStopped(undefined);
    setScopes([]);
    setLastResult(undefined);
    setStatus("running");
    setLayout("panelOpen", true);
    if (mode !== "profile" && layout.panel !== "console") setLayout("panel", "output");
  });
  const verb = { run: "Running", debug: "Debugging", profile: "Profiling" }[mode];
  out(`${verb} ${MAIN}`, "info");
  if (ws.files[HOST_FILE] != null && !ws.hostTrusted) out("host.js isn't trusted yet, running without it (Engine panel)", "info");
  const s = new Session(mode, {
    files: runnableFiles(),
    main: MAIN,
    settings: unwrap(ws.settings),
    host: ws.hostTrusted ? ws.files[HOST_FILE] ?? null : null,
    breakpoints: unwrap(ws.breakpoints),
  }, {
    print: (text, kind) => {
      out(text, kind === "log" ? "log" : kind === "host" ? "host" : "out");
      if (kind === "log") push(setConsoleLines, { text, kind: "log" });
    },
    stopped: onStopped,
    done: (r, crash) => onDone(mode, r, crash),
    hostError: (m) => {
      out(`host.js: ${m}`, "err");
      setHostProblem(m);
    },
    hostTypes: (list) => list.forEach((p) => out(`host.js: ${p.name} has a bad type, ${p.message}`, "err")),
  });
  setSession(s);
  if (mode === "debug") setLayout("side", "debug");
}

function onStopped(s: Stopped) {
  batch(() => {
    setStatus("paused");
    setStopped(s);
    setFrame(0);
    setScopes(s.scopes);
    setLayout("side", "debug");
  });
  reveal(s.file, s.line);
  evalWatches();
}

function onDone(mode: Mode, r: Result | null, crash?: string) {
  batch(() => {
    setStatus("idle");
    setStopped(undefined);
    setScopes([]);
  });
  stopDecorations?.clear();
  if (!r) {
    out(crash === "stopped" ? "Stopped" : `The run worker died: ${crash}`, crash === "stopped" ? "info" : "err");
    return;
  }
  setLastResult(r);
  if (r.error && !r.error.stopped) {
    out(r.error.rendered.trimEnd(), "err");
    showRunError(r.error);
  } else if (r.error?.stopped) {
    out("Stopped from the debugger", "info");
  }
  for (const e of r.moreErrors ?? []) out(e.trimEnd(), "err");
  if (r.values?.length) out(`← ${r.values.join(", ")}`, "value");
  if (r.suspended) out("main.rhue is still waiting on something, nothing left to wake it", "info");
  const h = r.heap;
  out(`${r.error && !r.error.stopped ? "Failed" : "Done"} in ${fmtMs(r.elapsedMs)} · ${fmtBytes(h.bytes)} heap · ${h.tables} tables, ${h.functions} functions, ${h.strings} strings · ${h.collections} GC${h.collections === 1 ? "" : "s"}`, r.error && !r.error.stopped ? "err" : "ok");
  if (mode === "profile" && r.profile) {
    showHeat(r);
    setLayout("panel", "profile");
  }
}

function resume(how: "continue" | "stepIn" | "stepOver" | "stepOut") {
  const s = session();
  if (!s || status() !== "paused") return;
  stopDecorations?.clear();
  batch(() => {
    setStatus("running");
    setStopped(undefined);
  });
  s.resume(how);
}

function stop() {
  session()?.stop();
}

function restart() {
  const s = session();
  const mode = (s?.mode === "idle" ? "debug" : s?.mode) ?? "debug";
  s?.stop();
  // the old worker is gone, give it a tick to report back
  setTimeout(() => start(mode), 50);
}

// ─ Stopped ───────────────────────────────────────────────────────────────────

function reveal(path: string, line: number, col = 1) {
  if (!(path in ws.files)) return;
  openFile(path);
  queueMicrotask(() => {
    if (!editor) return;
    editor.revealLineInCenterIfOutsideViewport(line);
    editor.setPosition({ lineNumber: line, column: col });
    if (stopped()) paintStop();
  });
}

function paintStop() {
  const s = stopped();
  if (!editor || !s) return stopDecorations?.clear();
  const f = s.frames[frame()];
  const path = f?.file ?? s.file;
  if (editor.getModel() !== models.get(path)) return stopDecorations?.clear();
  const line = f?.line ?? s.line;
  stopDecorations ??= editor.createDecorationsCollection();
  stopDecorations.set([{
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: frame() === 0 ? "pg-stop-line" : "pg-frame-line", glyphMarginClassName: frame() === 0 ? "pg-stop-arrow" : "pg-frame-arrow", zIndex: 10 },
  }]);
}

async function selectFrame(i: number) {
  const s = session();
  const st = stopped();
  if (!s || !st) return;
  setFrame(i);
  const f = st.frames[i];
  if (f?.file) reveal(f.file, f.line);
  setScopes(await s.scopes(i));
  paintStop();
  evalWatches();
}

async function evalWatches() {
  const s = session();
  if (!s || status() !== "paused") return;
  const res: Record<string, Variable | string> = {};
  for (const w of ws.watches) {
    const r = await s.evalIn(w, frame());
    res[w] = r.result ?? (r.error ?? "?");
  }
  setWatchResults(res);
}

// ─ Profile heat ──────────────────────────────────────────────────────────────

function clearHeat() {
  heatByFile.clear();
  heatDecorations?.clear();
}

function showHeat(r: Result) {
  clearHeat();
  const lines = r.profile?.lines ?? [];
  const top = Math.max(...lines.map((l) => l.ms), 0.0001);
  for (const l of lines) {
    const share = l.ms / top;
    const level = share > 0.66 ? 5 : share > 0.33 ? 4 : share > 0.15 ? 3 : share > 0.05 ? 2 : 1;
    const list = heatByFile.get(l.file) ?? [];
    list.push({ range: new monaco.Range(l.line, 1, l.line, 1), options: { isWholeLine: true, className: `pg-heat pg-heat-${level}` } });
    // the label sits past the end of the line, so it needs a range there
    const end = models.get(l.file)?.getLineMaxColumn(l.line) ?? 1;
    list.push({
      range: new monaco.Range(l.line, end, l.line, end),
      options: { showIfCollapsed: true, after: { content: `   ${l.hits.toLocaleString()}× · ${fmtMs(l.ms)}`, inlineClassName: `pg-heat-label pg-heat-label-${level}` } },
    });
    heatByFile.set(l.file, list);
  }
  paintHeat();
}

function paintHeat() {
  if (!editor) return;
  heatDecorations ??= editor.createDecorationsCollection();
  heatDecorations.set(heatByFile.get(ws.active) ?? []);
}

// ─ Commands ──────────────────────────────────────────────────────────────────

function toggleBpAtCursor() {
  const p = editor?.getPosition();
  if (!p || !isRhue(ws.active)) return;
  toggleBreakpoint(ws.active, p.lineNumber);
}

async function share() {
  try {
    const url = await shareLink();
    history.replaceState(null, "", url.slice(location.origin.length));
    await navigator.clipboard.writeText(url);
    notify(ws.files[HOST_FILE] != null ? "Link copied. It brings host.js along, people have to trust it before it runs" : "Link copied");
  } catch {
    notify("Couldn't copy, the link's in the address bar");
  }
}

function loadExample(ex: Example) {
  session()?.stop();
  const prev = previousSnapshot();
  for (const p of [...models.keys()]) disposeModel(p);
  replaceWorkspace(fromExample(ex));
  afterWorkspaceSwap();
  notify(`Opened ${ex.title}`, prev ? "Undo" : undefined, prev ? () => {
    for (const p of [...models.keys()]) disposeModel(p);
    const back = previousWorkspace();
    if (back) replaceWorkspace(back);
    afterWorkspaceSwap();
  } : undefined);
}

const previousSnapshot = () => Object.keys(ws.files).length > 0;

function afterWorkspaceSwap() {
  for (const [p, t] of Object.entries(ws.files)) if (isRhue(p)) void lang.setFile(p, t);
  showActive();
  scheduleHost(0);
  scheduleBytecode(0);
  setOutput([]);
  clearHeat();
}

function showActive() {
  if (!editor) return;
  const path = ws.active;
  const cur = editor.getModel();
  if (cur) viewStates.set(pathOf(cur.uri), editor.saveViewState());
  const m = modelFor(path);
  if (cur !== m) {
    editor.setModel(m);
    const vs = viewStates.get(path);
    if (vs) editor.restoreViewState(vs);
  }
  editor.updateOptions({ readOnly: path === RUST_TAB, glyphMargin: true });
  renderBreakpoints(path);
  paintStop();
  paintHeat();
  refreshSymbols();
  scheduleBytecode(0);
}

function newFile() {
  let n = 1;
  let name = "module.rhue";
  while (name in ws.files) name = `module${++n}.rhue`;
  addFile(name, `-- require("${name.replace(/\.rhue$/, "")}") gets whatever this returns\n\nlocal M = {}\n\nfunction M.hello(name: string): string\n    return \`hello {name}\`\nend\n\nreturn M\n`);
  void lang.setFile(name, ws.files[name]);
  setRenaming(name);
}

const [renaming, setRenaming] = createSignal<string | undefined>();

function doRename(from: string, to: string) {
  to = to.trim();
  setRenaming(undefined);
  if (!to || to === from) return;
  if (!/^[A-Za-z_][\w-]*(\.rhue|\.js)$/.test(to)) {
    if (/^[A-Za-z_][\w-]*$/.test(to)) to += ".rhue";
    else return notify("File names are a module name plus .rhue");
  }
  if (to in ws.files) return notify(`${to} already exists`);
  const text = ws.files[from];
  if (!renameFile(from, to)) return;
  disposeModel(from);
  void lang.removeFile(from);
  if (isRhue(to)) void lang.setFile(to, text);
  showActive();
  scheduleCheck(0);
}

function removeFile(path: string) {
  deleteFile(path);
  disposeModel(path);
  if (isRhue(path)) void lang.removeFile(path);
  if (path === HOST_FILE) scheduleHost(0);
  showActive();
  scheduleCheck(0);
}

function openHost() {
  if (ws.files[HOST_FILE] == null) addFile(HOST_FILE, HOST_TEMPLATE);
  else openFile(HOST_FILE);
  scheduleHost(0);
}

function openRust() {
  openFile(RUST_TAB);
  refreshRust();
}

// ─ Console ───────────────────────────────────────────────────────────────────

async function consoleEval(src: string) {
  push(setConsoleLines, { text: src, kind: "echo" });
  let s = session();
  if (s && status() === "paused") {
    const r = await s.evalIn(src, frame());
    if (r.error) push(setConsoleLines, { text: r.error, kind: "err" });
    else if (r.result) push(setConsoleLines, { text: r.result.value, kind: "value" });
    return;
  }
  if (s && status() === "running") {
    push(setConsoleLines, { text: "the script's still running, the console gets it when it's done or paused", kind: "info" });
    return;
  }
  if (!s) {
    // nothing's run yet, so make an engine with the same setup to talk to
    s = new Session("idle", {
      files: runnableFiles(), main: MAIN, settings: unwrap(ws.settings),
      host: ws.hostTrusted ? ws.files[HOST_FILE] ?? null : null, breakpoints: {},
    }, {
      print: (text) => push(setConsoleLines, { text, kind: "out" }),
      stopped: () => {}, done: () => {}, hostError: () => {}, hostTypes: () => {},
    });
    setSession(s);
  }
  const r = await s.evaluate(src);
  if (r.error) push(setConsoleLines, { text: r.error.rendered.trimEnd(), kind: "err" });
  else if (r.values?.length) push(setConsoleLines, { text: r.values.join("\t"), kind: "value" });
}

// ─ Page ──────────────────────────────────────────────────────────────────────

export default function Playground() {
  useTitle(() => "Playground");
  let host!: HTMLDivElement;
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal<string>();

  onMount(async () => {
    const linked = await fromLink(location.hash);
    if (linked) {
      for (const p of [...models.keys()]) disposeModel(p);
      replaceWorkspace(linked);
      history.replaceState(null, "", "/playground");
      if (!linked.hostTrusted) notify("This link came with a host.js. It won't run until you trust it in the Engine panel");
    }
    let started: { legend: { types: string[]; modifiers: string[] }; version: string };
    try {
      started = await lang.ready;
    } catch (e) {
      setFailed(String((e as Error).message ?? e));
      return;
    }
    setVersion(started.version);
    registerRhue(lang, started.legend);
    applyTheme();
    monaco.editor.registerEditorOpener({
      openCodeEditor(_src, resource, selection) {
        const path = pathOf(resource);
        if (!(path in ws.files)) return false;
        openFile(path);
        queueMicrotask(() => {
          if (!editor || !selection) return;
          if ("startLineNumber" in selection) {
            editor.setSelection(selection);
            editor.revealRangeInCenterIfOutsideViewport(selection);
          } else {
            editor.setPosition(selection);
            editor.revealPositionInCenterIfOutsideViewport(selection);
          }
        });
        return true;
      },
    });

    for (const [p, t] of Object.entries(ws.files)) if (isRhue(p)) await lang.setFile(p, t);
    editor = monaco.editor.create(host, {
      model: modelFor(ws.active),
      automaticLayout: true,
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      tabSize: 4,
      insertSpaces: true,
      glyphMargin: true,
      lineNumbersMinChars: 3,
      minimap: { enabled: true, renderCharacters: false, scale: 1, maxColumn: 80 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "all",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true },
      inlayHints: { enabled: "on" },
      "semanticHighlighting.enabled": true,
      padding: { top: 8 },
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      suggest: { showStatusBar: true, preview: true },
    });
    setReady(true);
    showActive();
    scheduleHost(0);
    scheduleCheck(0);

    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));

    // gutter: click for a breakpoint, right-click to edit one, a faint dot on hover
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (!line || !isRhue(ws.active)) return;
      if (e.event.rightButton) {
        setBpEditor({ path: ws.active, line, x: e.event.posx, y: e.event.posy });
        return;
      }
      toggleBreakpoint(ws.active, line);
    });
    hoverGlyph = editor.createDecorationsCollection();
    editor.onMouseMove((e) => {
      const line = e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position?.lineNumber : undefined;
      if (!line || !isRhue(ws.active) || (ws.breakpoints[ws.active] ?? []).some((b) => b.line === line)) return hoverGlyph?.clear();
      hoverGlyph?.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "pg-bp pg-bp-hint" } }]);
    });
    editor.onMouseLeave(() => hoverGlyph?.clear());

    // ─ actions (all in F1 too) ─
    const K = monaco.KeyMod, C = monaco.KeyCode;
    const act = (id: string, label: string, keys: number[], run: () => void, menu?: string) =>
      editor!.addAction({ id, label, keybindings: keys, run, contextMenuGroupId: menu, contextMenuOrder: 1 });
    act("rhue.debug", "Rhue: Start Debugging / Continue", [C.F5], () => (status() === "paused" ? resume("continue") : start("debug")), "rhue");
    act("rhue.run", "Rhue: Run Without Debugging", [K.CtrlCmd | C.F5], () => start("run"), "rhue");
    act("rhue.profile", "Rhue: Profile", [K.CtrlCmd | K.Alt | C.F5], () => start("profile"), "rhue");
    act("rhue.stop", "Rhue: Stop", [K.Shift | C.F5], stop);
    act("rhue.restart", "Rhue: Restart", [K.CtrlCmd | K.Shift | C.F5], restart);
    act("rhue.stepOver", "Rhue: Step Over", [C.F10], () => resume("stepOver"));
    act("rhue.stepIn", "Rhue: Step Into", [C.F11], () => resume("stepIn"));
    act("rhue.stepOut", "Rhue: Step Out", [K.Shift | C.F11], () => resume("stepOut"));
    act("rhue.breakpoint", "Rhue: Toggle Breakpoint", [C.F9], toggleBpAtCursor, "rhue");
    act("rhue.share", "Rhue: Copy Share Link", [], share);
    act("rhue.rust", "Rhue: Show the Engine as Rust", [], openRust);
    act("rhue.host", "Rhue: Open host.js", [], openHost);
    act("rhue.panel", "View: Toggle Panel", [K.CtrlCmd | C.Backquote], () => setLayout("panelOpen", (o) => !o));
    act("rhue.side", "View: Toggle Side Bar", [K.CtrlCmd | C.KeyB], () => setLayout("side", (s) => (s ? null : "explorer")));
    act("rhue.save", "Rhue: Save (format and keep locally)", [K.CtrlCmd | C.KeyS], () => {
      void editor!.getAction("editor.action.formatDocument")?.run();
      persist();
      notify("Saved in this browser");
    });

    // the same keys when focus is somewhere else on the page
    const keys = (e: KeyboardEvent) => {
      if (editor?.hasTextFocus()) return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "F5") {
        e.preventDefault();
        if (e.shiftKey && ctrl) restart();
        else if (e.shiftKey) stop();
        else if (ctrl && e.altKey) start("profile");
        else if (ctrl) start("run");
        else if (status() === "paused") resume("continue");
        else start("debug");
      } else if (e.key === "F10") { e.preventDefault(); resume("stepOver"); }
      else if (e.key === "F11") { e.preventDefault(); resume(e.shiftKey ? "stepOut" : "stepIn"); }
      else if (ctrl && e.key === "s") { e.preventDefault(); persist(); notify("Saved in this browser"); }
    };
    window.addEventListener("keydown", keys);
    onCleanup(() => window.removeEventListener("keydown", keys));
  });

  // ─ reactions ─
  createEffect(on(() => ws.active, () => showActive(), { defer: true }));
  createEffect(on(() => JSON.stringify(ws.breakpoints), () => {
    renderBreakpoints(ws.active);
    session()?.setBreakpoints(unwrap(ws.breakpoints));
  }, { defer: true }));
  createEffect(on(theme, () => editor && applyTheme(), { defer: true }));
  createEffect(on(() => ws.settings.typeMode, (m) => void lang.setMode(m).then(() => scheduleCheck(0))));
  createEffect(on(() => JSON.stringify(ws.settings), () => { refreshRust(); scheduleBytecode(0); persist(); }, { defer: true }));
  createEffect(on(() => ws.hostTrusted, () => scheduleHost(0), { defer: true }));
  createEffect(on(() => [layout.side, layout.sideWidth, layout.panelHeight, layout.panelOpen], () => persist(), { defer: true }));
  createEffect(on(frame, () => paintStop(), { defer: true }));

  onCleanup(() => {
    session()?.dispose();
    setSession(undefined);
    editor?.dispose();
    editor = undefined;
    for (const p of [...models.keys()]) disposeModel(p);
    stopDecorations = heatDecorations = hoverGlyph = undefined;
  });

  return (
    <div class="pg" classList={{ "pg-debugging": status() !== "idle" && session()?.mode === "debug" }}>
      <ActivityBar />
      <Show when={layout.side}>
        <aside class="pg-side" style={{ width: `${layout.sideWidth}px` }}>
          <Show when={layout.side === "explorer"}><Explorer /></Show>
          <Show when={layout.side === "debug"}><DebugView /></Show>
          <Show when={layout.side === "engine"}><EngineView /></Show>
          <Show when={layout.side === "examples"}><ExamplesView /></Show>
        </aside>
        <Resizer axis="x" get={() => layout.sideWidth} set={(v) => setLayout("sideWidth", Math.max(180, Math.min(520, v)))} />
      </Show>
      <section class="pg-main">
        <Tabs />
        <div class="pg-editor-wrap">
          <div class="pg-editor" ref={host} />
          <Show when={!ready()}>
            <div class="pg-loading">
              <Show when={failed()} fallback={<><span class="pg-spinner" />Starting Rhue…</>}>
                <span class="aa-icon">error</span>Rhue didn't start: {failed()}
              </Show>
            </div>
          </Show>
          <Show when={session()?.mode === "debug" && status() !== "idle"}><DebugToolbar /></Show>
        </div>
        <Show when={layout.panelOpen}>
          <Resizer axis="y" get={() => layout.panelHeight} set={(v) => setLayout("panelHeight", Math.max(90, Math.min(window.innerHeight * 0.7, v)))} invert />
          <Panel />
        </Show>
      </section>
      <StatusBar />
      <Show when={bpEditor()}>{(b) => <BreakpointEditor {...b()} />}</Show>
      <Show when={toast()}>{(t) => (
        <div class="pg-toast" role="status">
          <span>{t().text}</span>
          <Show when={t().action}><button class="pg-link" onClick={() => { t().run?.(); setToast(undefined); }}>{t().action}</button></Show>
          <button class="pg-x" aria-label="Dismiss" onClick={() => setToast(undefined)}><span class="aa-icon">close</span></button>
        </div>
      )}</Show>
    </div>
  );
}

// ─ Chrome ────────────────────────────────────────────────────────────────────

function Resizer(props: { axis: "x" | "y"; get: () => number; set: (v: number) => void; invert?: boolean }) {
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const start = props.axis === "x" ? e.clientX : e.clientY;
    const from = props.get();
    const move = (m: PointerEvent) => {
      const d = (props.axis === "x" ? m.clientX : m.clientY) - start;
      props.set(from + (props.invert ? -d : d));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("pg-dragging");
    };
    document.body.classList.add("pg-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div class={`pg-resizer pg-resizer-${props.axis}`} onPointerDown={down} role="separator" aria-orientation={props.axis === "x" ? "vertical" : "horizontal"} />;
}

function ActivityBar() {
  const item = (id: NonNullable<typeof layout.side>, icon: string, label: string, badge?: () => number | string | undefined) => (
    <button class="pg-act" classList={{ "is-active": layout.side === id }} aria-label={label} title={label}
      onClick={() => setLayout("side", layout.side === id ? null : id)}>
      <span class="aa-icon">{icon}</span>
      <Show when={badge?.()}><span class="pg-act-badge">{badge!()}</span></Show>
    </button>
  );
  return (
    <nav class="pg-activity" aria-label="Views">
      {item("explorer", "description", "Explorer")}
      {item("debug", "bug_report", "Run and Debug", () => (status() === "paused" ? "‖" : undefined))}
      {item("engine", "memory", "Engine")}
      {item("examples", "auto_stories", "Examples")}
      <div class="pg-act-spacer" />
      <button class="pg-act" aria-label="Copy a share link" title="Copy a share link" onClick={share}><span class="aa-icon">share</span></button>
    </nav>
  );
}

function SideHead(props: { title: string; children?: JSX.Element }) {
  return (
    <div class="pg-side-head">
      <span>{props.title}</span>
      <div class="pg-side-actions">{props.children}</div>
    </div>
  );
}

function Section(props: { title: string; open?: boolean; actions?: JSX.Element; children: JSX.Element; grow?: boolean }) {
  const [open, setOpen] = createSignal(props.open ?? true);
  return (
    <div class="pg-section" classList={{ "is-open": open(), "is-grow": props.grow }}>
      <div class="pg-section-head">
        <button class="pg-section-toggle" onClick={() => setOpen(!open())} aria-expanded={open()}>
          <span class="aa-icon">{open() ? "expand_more" : "chevron_right"}</span>{props.title}
        </button>
        <div class="pg-side-actions">{props.actions}</div>
      </div>
      <Show when={open()}><div class="pg-section-body aa-scroll">{props.children}</div></Show>
    </div>
  );
}

function SmallIcon(props: { icon: string; label: string; onClick: (e: MouseEvent) => void; active?: boolean; disabled?: boolean }) {
  return (
    <button class="pg-icon" classList={{ "is-active": props.active }} aria-label={props.label} title={props.label} disabled={props.disabled}
      onClick={(e) => { e.stopPropagation(); props.onClick(e); }}>
      <span class="aa-icon">{props.icon}</span>
    </button>
  );
}

function fileIcon(path: string) {
  if (path === HOST_FILE) return <span class="pg-ficon pg-ficon-js">JS</span>;
  if (path.endsWith(".rs")) return <span class="pg-ficon pg-ficon-rs">RS</span>;
  return <img class="pg-ficon-img" src="/brand/icon.svg" alt="" width="14" height="14" />;
}

// ─ Explorer ──────────────────────────────────────────────────────────────────

function Explorer() {
  const files = createMemo(() => Object.keys(ws.files).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : a === HOST_FILE ? 1 : b === HOST_FILE ? -1 : a.localeCompare(b))));
  const count = (p: string) => (problems()[p] ?? []).filter((x) => x.severity === "error").length;
  return (
    <>
      <SideHead title="Explorer" />
      <Section title="Playground" grow actions={<>
        <SmallIcon icon="note_add" label="New module" onClick={newFile} />
        <SmallIcon icon="memory" label="Open host.js" onClick={openHost} />
      </>}>
        <ul class="pg-tree" role="tree">
          <For each={files()}>{(path) => (
            <li role="treeitem" class="pg-row" classList={{ "is-active": ws.active === path }} onClick={() => openFile(path)}
              onDblClick={() => path !== MAIN && setRenaming(path)}>
              {fileIcon(path)}
              <Show when={renaming() === path} fallback={<span class="pg-row-name" classList={{ "has-errors": count(path) > 0 }}>{path}</span>}>
                <input class="pg-rename" value={path} ref={(el) => queueMicrotask(() => { el.focus(); el.setSelectionRange(0, path.lastIndexOf(".")); })}
                  onKeyDown={(e) => { if (e.key === "Enter") doRename(path, e.currentTarget.value); if (e.key === "Escape") setRenaming(undefined); }}
                  onBlur={(e) => doRename(path, e.currentTarget.value)} onClick={(e) => e.stopPropagation()} />
              </Show>
              <Show when={count(path)}><span class="pg-count pg-count-err">{count(path)}</span></Show>
              <Show when={path !== MAIN}>
                <span class="pg-row-actions">
                  <SmallIcon icon="edit" label={`Rename ${path}`} onClick={() => setRenaming(path)} />
                  <SmallIcon icon="delete" label={`Delete ${path}`} onClick={() => removeFile(path)} />
                </span>
              </Show>
            </li>
          )}</For>
        </ul>
        <p class="pg-hint">Files next to main.rhue are modules: <code>require("util")</code> loads util.rhue.</p>
      </Section>
      <Section title="Outline">
        <Show when={symbols().length} fallback={<p class="pg-hint">{isRhue(ws.active) ? "Nothing declared yet" : "Outline is for .rhue files"}</p>}>
          <ul class="pg-tree"><For each={symbols()}>{(s) => <SymbolRow s={s} depth={0} />}</For></ul>
        </Show>
      </Section>
    </>
  );
}

const SYMBOL_ICONS: Record<number, string> = { 11: "function", 5: "data_object", 12: "function", 4: "category", 13: "variable", 14: "lock", 6: "function", 7: "label" };

function SymbolRow(props: { s: monaco.languages.DocumentSymbol; depth: number }) {
  const [open, setOpen] = createSignal(true);
  const kids = () => props.s.children ?? [];
  return (
    <li>
      <div class="pg-row" style={{ "padding-left": `${8 + props.depth * 12}px` }}
        onClick={() => { editor?.setPosition({ lineNumber: props.s.selectionRange.startLineNumber, column: props.s.selectionRange.startColumn }); editor?.revealLineInCenterIfOutsideViewport(props.s.selectionRange.startLineNumber); editor?.focus(); }}>
        <span class="pg-twist" onClick={(e) => { e.stopPropagation(); setOpen(!open()); }}>
          <Show when={kids().length}><span class="aa-icon">{open() ? "expand_more" : "chevron_right"}</span></Show>
        </span>
        <span class="aa-icon pg-sym-icon">{SYMBOL_ICONS[props.s.kind] ?? "label"}</span>
        <span class="pg-row-name">{props.s.name}</span>
        <span class="pg-row-detail">{props.s.detail}</span>
      </div>
      <Show when={open() && kids().length}><ul><For each={kids()}>{(k) => <SymbolRow s={k} depth={props.depth + 1} />}</For></ul></Show>
    </li>
  );
}

// ─ Run and Debug ─────────────────────────────────────────────────────────────

function VarTree(props: { v: Variable; depth: number; label?: string }) {
  const [open, setOpen] = createSignal(false);
  const [kids, setKids] = createSignal<Variable[]>();
  const toggle = async () => {
    if (props.v.ref == null) return;
    if (!open() && !kids()) setKids(await session()?.expand(props.v.ref).catch(() => []) ?? []);
    setOpen(!open());
  };
  return (
    <li>
      <div class="pg-row pg-var" style={{ "padding-left": `${8 + props.depth * 12}px` }} onClick={toggle} title={`${props.v.type}`}>
        <span class="pg-twist"><Show when={props.v.ref != null}><span class="aa-icon">{open() ? "expand_more" : "chevron_right"}</span></Show></span>
        <span class="pg-var-name">{props.label ?? props.v.name}</span>
        <span class="pg-var-sep">:</span>
        <span class={`pg-var-value pg-t-${props.v.type}`}>{props.v.value}</span>
      </div>
      <Show when={open()}><ul><For each={kids()}>{(k) => <VarTree v={k} depth={props.depth + 1} />}</For></ul></Show>
    </li>
  );
}

function DebugView() {
  const [watchInput, setWatchInput] = createSignal("");
  const allBps = createMemo(() => Object.entries(ws.breakpoints).flatMap(([path, list]) => list.map((b) => ({ path, ...b }))));
  return (
    <>
      <SideHead title="Run and Debug" />
      <div class="pg-debug-start">
        <Show when={status() === "idle"} fallback={
          <div class="pg-debug-state">
            <span class="pg-dot" classList={{ "is-paused": status() === "paused" }} />
            {status() === "paused" ? `Paused on ${stopped()?.reason ?? "a line"}` : session()?.mode === "profile" ? "Profiling…" : "Running…"}
          </div>
        }>
          <Button variant="primary" size="m" icon="play_arrow" onClick={() => start("debug")} disabled={!canDebug()}>Run and Debug</Button>
          <div class="pg-debug-row">
            <Button variant="secondary" size="s" icon="bolt" onClick={() => start("run")}>Run</Button>
            <Button variant="secondary" size="s" icon="local_fire_department" onClick={() => start("profile")}>Profile</Button>
          </div>
          <Show when={!canDebug()}><p class="pg-hint">This browser didn't give the page cross-origin isolation, which the debugger needs to pause a script. Run and Profile still work.</p></Show>
          <p class="pg-hint">Click left of a line number for a breakpoint, right-click it for a condition or a logpoint.</p>
        </Show>
      </div>
      <Section title="Variables" grow>
        <Show when={status() === "paused"} fallback={<p class="pg-hint">Shows up when the script's paused</p>}>
          <For each={scopes()}>{(sc) => (
            <Show when={sc.variables.length}>
              <div class="pg-scope">{sc.name}</div>
              <ul class="pg-tree"><For each={sc.variables}>{(v) => <VarTree v={v} depth={0} />}</For></ul>
            </Show>
          )}</For>
        </Show>
      </Section>
      <Section title="Watch" actions={<SmallIcon icon="refresh" label="Refresh" onClick={evalWatches} />}>
        <ul class="pg-tree">
          <For each={ws.watches}>{(w, i) => {
            const r = () => watchResults()[w];
            return (
              <li class="pg-watch">
                <Show when={typeof r() === "object"} fallback={
                  <div class="pg-row pg-var"><span class="pg-twist" /><span class="pg-var-name">{w}</span><span class="pg-var-sep">:</span>
                    <span class="pg-var-value pg-var-muted">{typeof r() === "string" ? (r() as string) : status() === "paused" ? "…" : "not paused"}</span></div>
                }>
                  <ul><VarTree v={r() as Variable} depth={0} label={w} /></ul>
                </Show>
                <SmallIcon icon="close" label="Remove watch" onClick={() => { setWs("watches", (list) => list.filter((_, j) => j !== i())); persist(); }} />
              </li>
            );
          }}</For>
        </ul>
        <input class="pg-input" placeholder="Add an expression" value={watchInput()} onInput={(e) => setWatchInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !watchInput().trim()) return;
            setWs("watches", (list) => [...list, watchInput().trim()]);
            setWatchInput("");
            persist();
            evalWatches();
          }} />
      </Section>
      <Section title="Call Stack">
        <Show when={stopped()} fallback={<p class="pg-hint">Not paused</p>}>
          <ul class="pg-tree">
            <For each={stopped()!.frames}>{(f, i) => (
              <li class="pg-row pg-frame" classList={{ "is-active": frame() === i() }} onClick={() => selectFrame(i())}>
                <span class="pg-frame-fn">{f.function === "<anonymous>" && i() === stopped()!.frames.length - 1 ? "main chunk" : f.function}</span>
                <span class="pg-row-detail">{f.file ?? f.source}:{f.line}</span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Section>
      <Section title="Breakpoints" actions={<SmallIcon icon="delete_sweep" label="Remove all" onClick={() => { setWs("breakpoints", {}); persist(); }} />}>
        <Show when={allBps().length} fallback={<p class="pg-hint">None yet</p>}>
          <ul class="pg-tree">
            <For each={allBps()}>{(b) => (
              <li class="pg-row pg-bp-row" onClick={() => reveal(b.path, b.line)}>
                <input type="checkbox" checked={b.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => updateBreakpoint(b.path, b.line, { enabled: e.currentTarget.checked })} />
                <span class={`pg-bp-mini ${bpClass(b)}`} />
                <span class="pg-row-name">{b.path}<span class="pg-row-detail">:{b.line}</span></span>
                <span class="pg-row-detail pg-bp-what">{b.log ? `log ${b.log}` : b.condition ? `if ${b.condition}` : b.hit ? `hit ${b.hit}` : ""}</span>
                <span class="pg-row-actions">
                  <SmallIcon icon="edit" label="Edit" onClick={(e) => setBpEditor({ path: b.path, line: b.line, x: e.clientX, y: e.clientY })} />
                  <SmallIcon icon="close" label="Remove" onClick={() => removeBreakpoint(b.path, b.line)} />
                </span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Section>
    </>
  );
}

function DebugToolbar() {
  const paused = () => status() === "paused";
  return (
    <div class="pg-dbg-bar" role="toolbar" aria-label="Debug">
      <span class="pg-dbg-grip aa-icon">drag_indicator</span>
      <Show when={paused()} fallback={<SmallIcon icon="pause" label="Pause (F6)" onClick={() => session()?.pause()} />}>
        <SmallIcon icon="play_arrow" label="Continue (F5)" onClick={() => resume("continue")} />
      </Show>
      <SmallIcon icon="redo" label="Step Over (F10)" onClick={() => resume("stepOver")} disabled={!paused()} />
      <SmallIcon icon="south" label="Step Into (F11)" onClick={() => resume("stepIn")} disabled={!paused()} />
      <SmallIcon icon="north" label="Step Out (Shift+F11)" onClick={() => resume("stepOut")} disabled={!paused()} />
      <SmallIcon icon="restart_alt" label="Restart (Ctrl+Shift+F5)" onClick={restart} />
      <SmallIcon icon="stop" label="Stop (Shift+F5)" onClick={stop} />
    </div>
  );
}

function BreakpointEditor(props: { path: string; line: number; x: number; y: number }) {
  const bp = () => (ws.breakpoints[props.path] ?? []).find((b) => b.line === props.line);
  const [kind, setKind] = createSignal<"condition" | "hit" | "log">(untrack(() => (bp()?.log ? "log" : bp()?.hit ? "hit" : "condition")));
  const [text, setText] = createSignal(untrack(() => bp()?.[kind()] ?? ""));
  const save = () => {
    updateBreakpoint(props.path, props.line, { condition: undefined, hit: undefined, log: undefined, [kind()]: text().trim() || undefined });
    setBpEditor(undefined);
  };
  const place = { left: `${Math.min(props.x, window.innerWidth - 380)}px`, top: `${Math.min(props.y + 8, window.innerHeight - 180)}px` };
  const hints = { condition: "Break when this is true, say  i == 4", hit: "Break on hit count, like  5  >= 3  or  % 2", log: "Print instead of stopping, {expressions} get filled in" };
  return (
    <>
      <div class="pg-scrim" onClick={() => setBpEditor(undefined)} />
      <div class="pg-pop" style={place} role="dialog" aria-label={`Breakpoint on line ${props.line}`}>
        <div class="pg-pop-head">
          <span>{props.path}:{props.line}</span>
          <SegmentedButton options={[{ value: "condition", label: "Condition" }, { value: "hit", label: "Hit count" }, { value: "log", label: "Log" }]}
            value={kind()} onChange={(v) => { setKind(v); setText(bp()?.[v as "condition"] ?? ""); }} />
        </div>
        <input class="pg-input mono" value={text()} placeholder={hints[kind()]} ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setBpEditor(undefined); }} />
        <div class="pg-pop-foot">
          <span class="pg-hint">{hints[kind()]}</span>
          <Show when={bp()}><Button variant="ghost" size="s" onClick={() => { removeBreakpoint(props.path, props.line); setBpEditor(undefined); }}>Remove</Button></Show>
          <Button variant="primary" size="s" onClick={save}>Save</Button>
        </div>
      </div>
    </>
  );
}

// ─ Engine ────────────────────────────────────────────────────────────────────

function EngineView() {
  const set = <K extends keyof typeof ws.settings>(k: K, v: (typeof ws.settings)[K]) => setWs("settings", k, v);
  const stats = (name: string) => lastResult()?.host.find((h) => h.name === name);
  return (
    <>
      <SideHead title="Engine">
        <SmallIcon icon="data_object" label="Show as Rust" onClick={openRust} />
      </SideHead>
      <div class="pg-side-scroll aa-scroll">
        <p class="pg-hint pg-pad">This is the host side, what a Rust app does to its <code>Engine</code> before it runs anything. Changes apply on the next run.</p>
        <Section title="Compiler">
          <div class="pg-field">
            <span class="pg-label">Type checking for files without a directive</span>
            <SegmentedButton options={[{ value: "nocheck", label: "Off" }, { value: "nonstrict", label: "Nonstrict" }, { value: "strict", label: "Strict" }]}
              value={ws.settings.typeMode} onChange={(v) => set("typeMode", v)} />
          </div>
          <Switch label={<span class="pg-label">Fold constants <span class="pg-dim">1 + 2 compiles to 3</span></span>} checked={ws.settings.foldConstants} onChange={(v) => set("foldConstants", v)} />
          <Button variant="ghost" size="s" icon="memory_alt" onClick={() => { setLayout("panelOpen", true); setLayout("panel", "bytecode"); }}>See the bytecode</Button>
        </Section>
        <Section title="Limits">
          <LimitField label="Instructions" value={ws.settings.instructionLimit} unit="" scale={1} onChange={(v) => set("instructionLimit", v)} />
          <LimitField label="Memory" value={ws.settings.memoryLimit} unit="MB" scale={1024 * 1024} onChange={(v) => set("memoryLimit", v)} />
          <Switch label={<span class="pg-label">Task library <span class="pg-dim">task.spawn, wait, delay</span></span>} checked={ws.settings.tasks} onChange={(v) => set("tasks", v)} />
          <Switch label={<span class="pg-label">GC stress <span class="pg-dim">collect before every instruction, slow</span></span>} checked={ws.settings.gcStress} onChange={(v) => set("gcStress", v)} />
        </Section>
        <Section title="Host functions" actions={<SmallIcon icon="edit" label="Edit host.js" onClick={openHost} />}>
          <Show when={ws.files[HOST_FILE] != null && !ws.hostTrusted}>
            <div class="pg-trust">
              <span class="aa-icon">gpp_maybe</span>
              <div>
                <strong>host.js came with a link.</strong> It's JavaScript that runs in this page when you run a script. Read it first.
                <div class="pg-trust-actions">
                  <Button variant="secondary" size="s" onClick={() => openFile(HOST_FILE)}>Read it</Button>
                  <Button variant="primary" size="s" onClick={() => { setWs("hostTrusted", true); persist(); }}>Trust it</Button>
                </div>
              </div>
            </div>
          </Show>
          <Show when={ws.files[HOST_FILE] != null} fallback={
            <div class="pg-pad">
              <p class="pg-hint">No host.js yet. It's where you add natives: functions written in the host that scripts call, sync or async, with types the checker knows about.</p>
              <Button variant="secondary" size="s" icon="add" onClick={openHost}>Make host.js</Button>
            </div>
          }>
            <Show when={hostProblem()}><p class="pg-hint pg-err pg-pad">{hostProblem()}</p></Show>
            <ul class="pg-tree">
              <For each={hostDecls()} fallback={<p class="pg-hint pg-pad">host.js doesn't add anything yet</p>}>{(d) => (
                <li class="pg-host">
                  <div class="pg-host-top">
                    <span class="pg-host-name">{d.name}</span>
                    <Show when={d.async}><span class="pg-tag">async</span></Show>
                    <Show when={d.value}><span class="pg-tag">value</span></Show>
                  </div>
                  <code class="pg-host-type">{d.type ?? "untyped, scripts see any"}</code>
                  <Show when={stats(d.name)}>{(s) => (
                    <span class="pg-host-stats">{s().calls.toLocaleString()} call{s().calls === 1 ? "" : "s"} · {fmtMs(s().ms)} · {fmtMs(s().ms / Math.max(1, s().calls))} each</span>
                  )}</Show>
                </li>
              )}</For>
            </ul>
          </Show>
        </Section>
        <Section title="Last run">
          <Show when={lastResult()} fallback={<p class="pg-hint pg-pad">Run something</p>}>{(r) => (
            <dl class="pg-stats">
              <dt>Time</dt><dd>{fmtMs(r().elapsedMs)}</dd>
              <dt>Heap</dt><dd>{fmtBytes(r().heap.bytes)}</dd>
              <dt>Tables</dt><dd>{r().heap.tables}</dd>
              <dt>Functions</dt><dd>{r().heap.functions}</dd>
              <dt>Strings</dt><dd>{r().heap.strings}</dd>
              <dt>Threads</dt><dd>{r().heap.threads}</dd>
              <dt>Collections</dt><dd>{r().heap.collections}</dd>
              <Show when={r().profile}><dt>Lines run</dt><dd>{r().profile!.totalLines.toLocaleString()}</dd></Show>
            </dl>
          )}</Show>
        </Section>
      </div>
    </>
  );
}

function LimitField(props: { label: string; value: number | null; unit: string; scale: number; onChange: (v: number | null) => void }) {
  return (
    <div class="pg-field pg-limit">
      <Switch label={<span class="pg-label">{props.label}</span>} checked={props.value != null}
        onChange={(on) => props.onChange(on ? (props.scale > 1 ? 256 : 500_000_000) * props.scale : null)} />
      <Show when={props.value != null}>
        <div class="pg-num">
          <input class="pg-input mono" type="number" min="1" value={Math.round((props.value ?? 0) / props.scale)}
            onChange={(e) => { const n = Number(e.currentTarget.value); if (n > 0) props.onChange(n * props.scale); }} />
          <Show when={props.unit}><span class="pg-dim">{props.unit}</span></Show>
        </div>
      </Show>
    </div>
  );
}

// ─ Examples ──────────────────────────────────────────────────────────────────

function ExamplesView() {
  return (
    <>
      <SideHead title="Examples" />
      <div class="pg-side-scroll aa-scroll">
        <p class="pg-hint pg-pad">Each one swaps out your files. The old ones come back with Undo.</p>
        <ul class="pg-examples">
          <For each={EXAMPLES}>{(ex) => (
            <li>
              <button class="pg-example" onClick={() => loadExample(ex)}>
                <span class="aa-icon">{ex.icon}</span>
                <span class="pg-example-text"><strong>{ex.title}</strong><span>{ex.blurb}</span></span>
              </button>
            </li>
          )}</For>
        </ul>
      </div>
    </>
  );
}

// ─ Tabs ──────────────────────────────────────────────────────────────────────

function Tabs() {
  const running = () => status() !== "idle";
  return (
    <div class="pg-tabs-row">
      <div class="pg-tabs aa-scroll" role="tablist">
        <For each={ws.open}>{(path) => (
          <div class="pg-tab" role="tab" aria-selected={ws.active === path} classList={{ "is-active": ws.active === path }}
            onClick={() => openFile(path)} onAuxClick={(e) => e.button === 1 && closeFile(path)}>
            {fileIcon(path)}
            <span>{path}</span>
            <Show when={path === RUST_TAB}><span class="pg-tag">preview</span></Show>
            <button class="pg-tab-x" aria-label={`Close ${path}`} onClick={(e) => { e.stopPropagation(); closeFile(path); }}><span class="aa-icon">close</span></button>
          </div>
        )}</For>
      </div>
      <div class="pg-run">
        <Show when={!running()} fallback={
          <button class="pg-run-btn is-stop" onClick={stop} title="Stop (Shift+F5)"><span class="aa-icon">stop</span>Stop</button>
        }>
          <button class="pg-run-btn" onClick={() => start("run")} title="Run (Ctrl+F5)"><span class="aa-icon">play_arrow</span>Run</button>
          <SmallIcon icon="bug_report" label={canDebug() ? "Debug (F5)" : "Debugging needs cross-origin isolation"} onClick={() => start("debug")} disabled={!canDebug()} />
          <SmallIcon icon="local_fire_department" label="Profile (Ctrl+Alt+F5)" onClick={() => start("profile")} />
        </Show>
        <SmallIcon icon="format_align_left" label="Format (Shift+Alt+F)" onClick={() => editor?.getAction("editor.action.formatDocument")?.run()} />
      </div>
    </div>
  );
}

// ─ Panel ─────────────────────────────────────────────────────────────────────

function Panel() {
  const counts = createMemo(() => {
    const all = Object.values(problems()).flat();
    return { errors: all.filter((p) => p.severity === "error").length, warnings: all.filter((p) => p.severity === "warning").length };
  });
  const tab = (id: typeof layout.panel, label: string, badge?: () => number) => (
    <button class="pg-ptab" classList={{ "is-active": layout.panel === id }} role="tab" aria-selected={layout.panel === id} onClick={() => setLayout("panel", id)}>
      {label}<Show when={badge?.()}><span class="pg-count">{badge!()}</span></Show>
    </button>
  );
  return (
    <div class="pg-panel" style={{ height: `${layout.panelHeight}px` }}>
      <div class="pg-panel-head">
        <div class="pg-ptabs" role="tablist">
          {tab("output", "Output")}
          {tab("problems", "Problems", () => counts().errors + counts().warnings)}
          {tab("console", "Debug Console")}
          {tab("bytecode", "Bytecode")}
          {tab("profile", "Profile")}
        </div>
        <div class="pg-side-actions">
          <Show when={layout.panel === "output"}><SmallIcon icon="block" label="Clear output" onClick={() => setOutput([])} /></Show>
          <Show when={layout.panel === "console"}><SmallIcon icon="block" label="Clear console" onClick={() => setConsoleLines([])} /></Show>
          <Show when={layout.panel === "bytecode"}>
            <label class="pg-inline-switch"><input type="checkbox" checked={ws.settings.foldConstants} onChange={(e) => setWs("settings", "foldConstants", e.currentTarget.checked)} />fold constants</label>
          </Show>
          <SmallIcon icon={layout.panelHeight > window.innerHeight * 0.5 ? "keyboard_arrow_down" : "keyboard_arrow_up"} label="Maximize panel"
            onClick={() => setLayout("panelHeight", layout.panelHeight > window.innerHeight * 0.5 ? 240 : Math.round(window.innerHeight * 0.68))} />
          <SmallIcon icon="close" label="Close panel" onClick={() => setLayout("panelOpen", false)} />
        </div>
      </div>
      <div class="pg-panel-body">
        <Show when={layout.panel === "output"}><Lines lines={output()} empty="Ctrl+F5 runs main.rhue. print() and errors land here." /></Show>
        <Show when={layout.panel === "problems"}><ProblemsView /></Show>
        <Show when={layout.panel === "console"}><ConsoleView /></Show>
        <Show when={layout.panel === "bytecode"}><BytecodeView /></Show>
        <Show when={layout.panel === "profile"}><ProfileView /></Show>
      </div>
    </div>
  );
}

function Lines(props: { lines: Line[]; empty: string; children?: JSX.Element }) {
  let box!: HTMLDivElement;
  createEffect(on(() => props.lines.length, () => queueMicrotask(() => { if (box) box.scrollTop = box.scrollHeight; })));
  return (
    <div class="pg-lines aa-scroll" ref={box}>
      <Show when={props.lines.length} fallback={<p class="pg-hint">{props.empty}</p>}>
        <For each={props.lines}>{(l) => (
          <div class={`pg-line pg-line-${l.kind}`}>
            <Show when={l.kind === "echo"}><span class="pg-prompt">›</span></Show>
            <Show when={l.kind === "host"}><span class="pg-tag">host</span></Show>
            <Show when={l.kind === "log"}><span class="pg-tag pg-tag-log">log</span></Show>
            <span>{l.text}</span>
          </div>
        )}</For>
      </Show>
      {props.children}
    </div>
  );
}

function ProblemsView() {
  const list = createMemo(() => Object.values(problems()).flat().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line));
  return (
    <div class="pg-lines aa-scroll">
      <Show when={list().length} fallback={<p class="pg-hint">No problems. The checker runs as you type.</p>}>
        <For each={list()}>{(p) => (
          <button class="pg-problem" onClick={() => { reveal(p.file, p.line, p.col); editor?.focus(); }}>
            <span class={`aa-icon pg-sev-${p.severity}`}>{p.severity === "error" ? "error" : p.severity === "warning" ? "warning" : "info"}</span>
            <span class="pg-problem-msg">{p.message}</span>
            <span class="pg-row-detail">{p.file} [{p.line}, {p.col}]</span>
          </button>
        )}</For>
      </Show>
    </div>
  );
}

function ConsoleView() {
  const [input, setInput] = createSignal("");
  const history: string[] = [];
  let at = 0;
  return (
    <div class="pg-console">
      <Lines lines={consoleLines()} empty={status() === "paused" ? "Paused. Anything you type runs in the selected frame." : "Evaluates against the engine the last run left behind (its globals are still there). Expressions show their value."} />
      <div class="pg-console-input">
        <span class="pg-prompt">›</span>
        <input class="mono" value={input()} placeholder={status() === "paused" ? "an expression in this frame" : "1 + 1, or anything a script can do"}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input().trim()) {
              history.push(input());
              at = history.length;
              void consoleEval(input());
              setInput("");
            } else if (e.key === "ArrowUp" && at > 0) {
              setInput(history[--at]);
              e.preventDefault();
            } else if (e.key === "ArrowDown") {
              at = Math.min(history.length, at + 1);
              setInput(history[at] ?? "");
              e.preventDefault();
            }
          }} />
      </div>
    </div>
  );
}

function BytecodeView() {
  // a light colouring, the disassembly has a very regular shape
  const lines = createMemo(() => bytecode().split("\n"));
  const paint = (l: string) => {
    if (l.startsWith("--")) return <span class="pg-bc-comment">{l}</span>;
    if (l.startsWith("function ")) return <span class="pg-bc-fn">{l}</span>;
    const m = /^(\s*\d+\s+)([A-Z_]+)(\s+[^;]*)(;.*)?$/.exec(l);
    if (!m) return <span>{l}</span>;
    const args = m[3].split(/(\b[RKPU]\d+\b)/).map((part) =>
      /^R\d+$/.test(part) ? <span class="pg-bc-reg">{part}</span> : /^K\d+$/.test(part) ? <span class="pg-bc-k">{part}</span> : /^[PU]\d+$/.test(part) ? <span class="pg-bc-p">{part}</span> : part);
    return <><span class="pg-bc-pc">{m[1]}</span><span class="pg-bc-op">{m[2]}</span>{args}<Show when={m[4]}><span class="pg-bc-comment">{m[4]}</span></Show></>;
  };
  return (
    <pre class="pg-bytecode aa-scroll"><For each={lines()}>{(l) => <div>{paint(l)}</div>}</For></pre>
  );
}

function ProfileView() {
  const p = () => lastResult()?.profile;
  return (
    <div class="pg-lines aa-scroll">
      <Show when={p()} fallback={<div class="pg-hint">Profile (in the run menu, or Ctrl+Alt+F5) runs main.rhue counting every line and roughly how long it sat on each. Hot lines get coloured in the editor. <button class="pg-link" onClick={() => start("profile")}>Profile now</button></div>}>
        <div class="pg-prof">
          <div>
            <div class="pg-scope">Hottest lines</div>
            <table class="pg-table">
              <thead><tr><th>Line</th><th>Hits</th><th>Time</th><th /></tr></thead>
              <tbody>
                <For each={p()!.lines.slice(0, 40)}>{(l) => {
                  const total = p()!.lines.reduce((s, x) => s + x.ms, 0) || 1;
                  return (
                    <tr onClick={() => reveal(l.file, l.line)}>
                      <td class="mono">{l.file}:{l.line}</td>
                      <td class="mono">{l.hits.toLocaleString()}</td>
                      <td class="mono">{fmtMs(l.ms)}</td>
                      <td class="pg-bar-cell"><span class="pg-bar" style={{ width: `${Math.max(1, (l.ms / total) * 100)}%` }} /></td>
                    </tr>
                  );
                }}</For>
              </tbody>
            </table>
          </div>
          <div>
            <div class="pg-scope">Calls</div>
            <table class="pg-table">
              <thead><tr><th>Function</th><th>Where</th><th>Calls</th></tr></thead>
              <tbody>
                <For each={p()!.functions.slice(0, 40)}>{(f) => (
                  <tr onClick={() => reveal(f.file, f.line)}>
                    <td class="mono">{f.function}</td>
                    <td class="mono pg-dim">{f.file}:{f.line}</td>
                    <td class="mono">{f.calls.toLocaleString()}</td>
                  </tr>
                )}</For>
              </tbody>
            </table>
            <p class="pg-hint">{p()!.totalLines.toLocaleString()} lines ran. Times include the profiler's own overhead, so compare lines with each other, not with a plain run.</p>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ─ Status bar ────────────────────────────────────────────────────────────────

function StatusBar() {
  const counts = createMemo(() => {
    const all = Object.values(problems()).flat();
    return { errors: all.filter((p) => p.severity === "error").length, warnings: all.filter((p) => p.severity === "warning").length };
  });
  const cycle = () => {
    const order = ["nocheck", "nonstrict", "strict"] as const;
    setWs("settings", "typeMode", order[(order.indexOf(ws.settings.typeMode) + 1) % 3]);
  };
  const state = () => {
    if (status() === "paused") return `Paused on ${stopped()?.reason} · ${stopped()?.file}:${stopped()?.line}`;
    if (status() === "running") return session()?.mode === "profile" ? "Profiling…" : session()?.mode === "debug" ? "Debugging…" : "Running…";
    const r = lastResult();
    return r ? `Last run ${fmtMs(r.elapsedMs)}` : "";
  };
  return (
    <footer class="pg-status">
      <span class="pg-st"><span class="aa-icon">deployed_code</span>rhue {version()} · wasm</span>
      <button class="pg-st pg-st-btn" onClick={() => { setLayout("panelOpen", true); setLayout("panel", "problems"); }}>
        <span class="aa-icon">cancel</span>{counts().errors}<span class="aa-icon">warning</span>{counts().warnings}
      </button>
      <Show when={state()}><span class="pg-st">{status() !== "idle" && <span class="pg-spinner pg-spinner-s" />}{state()}</span></Show>
      <span class="pg-st-spacer" />
      <span class="pg-st">Ln {cursor().line}, Col {cursor().col}</span>
      <span class="pg-st">Spaces: 4</span>
      <button class="pg-st pg-st-btn" onClick={cycle} title="Type checking for files without a --! directive">{{ nocheck: "No checking", nonstrict: "Nonstrict", strict: "Strict" }[ws.settings.typeMode]}</button>
      <span class="pg-st">{languageOf(ws.active) === LANG ? "Rhue" : languageOf(ws.active) === "javascript" ? "JavaScript" : "Rust"}</span>
      <Show when={!canDebug()}><span class="pg-st" title="No cross-origin isolation, so no pausing">no debugger</span></Show>
    </footer>
  );
}
