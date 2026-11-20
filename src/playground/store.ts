// ─ Workspace ─────────────────────────────────────────────────────────────────
// files, breakpoints, engine settings and layout. kept in localStorage, and
// squashed into the url for share links

import { createStore, produce, unwrap } from "solid-js/store";
import type { Bp, Settings } from "./runner";
import { DEFAULT_EXAMPLE, type Example } from "./examples";

export const MAIN = "main.rhue";

export type Workspace = {
  files: Record<string, string>;
  open: string[];
  active: string;
  breakpoints: Record<string, Bp[]>;
  watches: string[];
  settings: Settings;
  /** host.js only runs once you've said it can (shared links bring their own) */
  hostTrusted: boolean;
};

export type Layout = {
  side: "explorer" | "debug" | "engine" | "examples" | null;
  sideWidth: number;
  panel: "output" | "problems" | "console" | "bytecode" | "profile";
  panelHeight: number;
  panelOpen: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  typeMode: "nonstrict",
  foldConstants: true,
  instructionLimit: 500_000_000,
  memoryLimit: 256 * 1024 * 1024,
  gcStress: false,
  tasks: true,
};

export function fromExample(ex: Example): Workspace {
  const open = [MAIN, ...Object.keys(ex.files).filter((f) => f !== MAIN)];
  return {
    files: { ...ex.files },
    open,
    active: ex.focus ?? MAIN,
    breakpoints: {},
    watches: [],
    settings: { ...DEFAULT_SETTINGS },
    hostTrusted: true,
  };
}

const KEY = "rhue-playground";
const PREVIOUS = "rhue-playground-previous";

function load<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // full or private mode, the playground still works, it just forgets
  }
}

function sane(w: Workspace | undefined): Workspace | undefined {
  if (!w || typeof w.files !== "object" || typeof w.files[MAIN] !== "string") return;
  const open = (w.open ?? []).filter((f) => f in w.files);
  return {
    files: w.files,
    open: open.length ? open : [MAIN],
    active: w.active in w.files ? w.active : MAIN,
    breakpoints: w.breakpoints ?? {},
    watches: w.watches ?? [],
    settings: { ...DEFAULT_SETTINGS, ...w.settings },
    hostTrusted: w.hostTrusted ?? true,
  };
}

export const [ws, setWs] = createStore<Workspace>(sane(load<Workspace>(KEY)) ?? fromExample(DEFAULT_EXAMPLE));

export const [layout, setLayout] = createStore<Layout>({
  side: "explorer",
  sideWidth: 260,
  panel: "output",
  panelHeight: 240,
  panelOpen: true,
  ...load<Partial<Layout>>(KEY + "-layout"),
});

let timer = 0;
/** Debounced, typing doesn't hit localStorage on every key */
export function persist() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    save(KEY, unwrap(ws));
    save(KEY + "-layout", unwrap(layout));
  }, 300);
}

/** Swaps in another workspace, keeping the current one for undo */
export function replaceWorkspace(next: Workspace) {
  save(PREVIOUS, unwrap(ws));
  setWs(structuredClone(next));
  persist();
}

export function previousWorkspace() {
  return sane(load<Workspace>(PREVIOUS));
}

export function setFile(path: string, text: string) {
  setWs("files", path, text);
  persist();
}

export function openFile(path: string) {
  setWs(produce((w) => {
    if (!w.open.includes(path)) w.open.push(path);
    w.active = path;
  }));
  persist();
}

export function closeFile(path: string) {
  setWs(produce((w) => {
    const i = w.open.indexOf(path);
    if (i < 0) return;
    w.open.splice(i, 1);
    if (w.active === path) w.active = w.open[Math.max(0, i - 1)] ?? MAIN;
    if (!w.open.length) w.open.push(MAIN);
  }));
  persist();
}

export function addFile(path: string, text = "") {
  setWs(produce((w) => {
    w.files[path] = text;
    if (!w.open.includes(path)) w.open.push(path);
    w.active = path;
  }));
  persist();
}

export function deleteFile(path: string) {
  if (path === MAIN) return;
  setWs(produce((w) => {
    delete w.files[path];
    delete w.breakpoints[path];
    w.open = w.open.filter((f) => f !== path);
    if (w.active === path) w.active = w.open[w.open.length - 1] ?? MAIN;
  }));
  persist();
}

export function renameFile(from: string, to: string) {
  if (from === MAIN || from === to || to in ws.files) return false;
  setWs(produce((w) => {
    w.files[to] = w.files[from];
    delete w.files[from];
    if (w.breakpoints[from]) {
      w.breakpoints[to] = w.breakpoints[from];
      delete w.breakpoints[from];
    }
    w.open = w.open.map((f) => (f === from ? to : f));
    if (w.active === from) w.active = to;
  }));
  persist();
  return true;
}

// ─ Breakpoints ───────────────────────────────────────────────────────────────

export function toggleBreakpoint(path: string, line: number) {
  setWs(produce((w) => {
    const list = (w.breakpoints[path] ??= []);
    const i = list.findIndex((b) => b.line === line);
    if (i >= 0) list.splice(i, 1);
    else list.push({ line, enabled: true });
    list.sort((a, b) => a.line - b.line);
  }));
  persist();
}

export function updateBreakpoint(path: string, line: number, patch: Partial<Bp>) {
  setWs(produce((w) => {
    const list = (w.breakpoints[path] ??= []);
    let bp = list.find((b) => b.line === line);
    if (!bp) {
      bp = { line, enabled: true };
      list.push(bp);
      list.sort((a, b) => a.line - b.line);
    }
    Object.assign(bp, patch);
    for (const k of ["condition", "hit", "log"] as const) if (!bp[k]) delete bp[k];
  }));
  persist();
}

export function removeBreakpoint(path: string, line: number) {
  setWs("breakpoints", path, (list) => (list ?? []).filter((b) => b.line !== line));
  persist();
}

// ─ Sharing ───────────────────────────────────────────────────────────────────
// the files and settings, deflated and base64url'd into #code=

type Shared = Pick<Workspace, "files" | "settings" | "breakpoints"> & { active?: string };

async function squash(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unsquash(code: string) {
  const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

export async function shareLink() {
  const shared: Shared = { files: unwrap(ws.files), settings: unwrap(ws.settings), breakpoints: unwrap(ws.breakpoints), active: ws.active };
  return `${location.origin}/playground#code=${await squash(JSON.stringify(shared))}`;
}

/** A workspace from the url, if it has one. host.js from a link isn't trusted yet */
export async function fromLink(hash: string): Promise<Workspace | undefined> {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code");
  if (!code) return;
  try {
    const s = JSON.parse(await unsquash(code)) as Shared;
    return sane({
      files: s.files,
      open: Object.keys(s.files).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b))),
      active: s.active ?? MAIN,
      breakpoints: s.breakpoints ?? {},
      watches: [],
      settings: s.settings,
      hostTrusted: !("host.js" in s.files),
    });
  } catch {
    return;
  }
}
