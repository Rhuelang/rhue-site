// ─ Run worker ────────────────────────────────────────────────────────────────
// one engine, one script. the page kills the whole worker to stop a runaway
// script, so nothing in here needs to be interruptible
//
// the debugger stops a script inside a synchronous hook, so pausing means
// actually blocking this thread: Atomics.wait on a SharedArrayBuffer until the
// page writes the next command. that's why debugging needs the page to be
// cross-origin isolated

import init, { configure, evaluate, run } from "./wasm/rhue_playground.js";
import type { HostDecl } from "./host";

// ─ Mailboxes ─────────────────────────────────────────────────────────────────
// ctrl[0] command waiting (A), ctrl[1] its length
// ctrl[2] breakpoint list version (B), ctrl[3] its length
// ctrl[4] pause asked for, ctrl[5] stop asked for

export const MAILBOX = 64 * 1024;
let ctrl: Int32Array | undefined;
let boxA: Uint8Array | undefined;
let boxB: Uint8Array | undefined;
let seenB = 0;
const dec = new TextDecoder();

function pause(msg: string | null): string {
  if (msg) self.postMessage({ type: "debug", msg });
  if (!ctrl || !boxA) return '{"cmd":"continue"}';
  Atomics.wait(ctrl, 0, 0);
  const text = dec.decode(boxA.slice(0, Atomics.load(ctrl, 1)));
  Atomics.store(ctrl, 0, 0);
  return text;
}

function poll(): string | null {
  if (!ctrl || !boxB) return null;
  if (Atomics.load(ctrl, 5)) return '{"cmd":"stop"}';
  if (Atomics.exchange(ctrl, 4, 0)) return '{"cmd":"pause"}';
  const v = Atomics.load(ctrl, 2);
  if (v !== seenB) {
    seenB = v;
    return `{"cmd":"setBreakpoints","bps":${dec.decode(boxB.slice(0, Atomics.load(ctrl, 3)))}}`;
  }
  return null;
}

// ─ host.js ───────────────────────────────────────────────────────────────────

type Native = HostDecl & { fn: (...args: any[]) => any };
type Global = { name: string; type?: string; value: unknown };

function print(text: string, kind?: string) {
  self.postMessage({ type: "print", text, kind: kind ?? "out" });
}

/** Runs host.js and collects what it adds. Throws whatever host.js throws */
function loadHost(source: string) {
  const natives: Native[] = [];
  const globals: Global[] = [];
  const named = (name: unknown) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${String(name)}" isn't a name scripts can use`);
    if (natives.some((n) => n.name === name) || globals.some((g) => g.name === name)) throw new Error(`${name} is already added`);
    return name;
  };
  // (name, fn) or (name, type, fn)
  const add = (isAsync: boolean) => (name: string, type: unknown, fn?: unknown) => {
    if (typeof type === "function") [type, fn] = [undefined, type];
    if (typeof fn !== "function") throw new Error(`host.${isAsync ? "async" : "fn"}("${name}", ...) needs a function`);
    natives.push({ name: named(name), type: typeof type === "string" ? type : undefined, async: isAsync, fn: fn as Native["fn"], source: String(fn) });
  };
  const host = {
    fn: add(false),
    async: add(true),
    value(name: string, type: unknown, value?: unknown) {
      if (value === undefined && typeof type !== "string") [type, value] = [undefined, type];
      globals.push({ name: named(name), type: typeof type === "string" ? type : undefined, value });
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
  const log = (...xs: unknown[]) => print(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "), "host");
  const hostConsole = { log, info: log, warn: log, error: log, debug: log };
  new Function("host", "console", `"use strict";\n${source}`)(host, hostConsole);
  return { natives, globals };
}

function decls(h: ReturnType<typeof loadHost>): HostDecl[] {
  return [
    ...h.natives.map(({ name, type, async, source }) => ({ name, type, async, source })),
    ...h.globals.map(({ name, type }) => ({ name, type, value: true })),
  ];
}

// ─ Messages ──────────────────────────────────────────────────────────────────

let started: Promise<unknown> | undefined;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "host") {
      // just what host.js declares, for the editor's checker
      const h = loadHost(m.source);
      self.postMessage({ type: "host", id: m.id, decls: decls(h) });
      return;
    }
    if (m.type === "start") {
      started ??= init({ module_or_path: m.module });
      await started;
      if (m.sab) {
        ctrl = new Int32Array(m.sab, 0, 8);
        boxA = new Uint8Array(m.sab, 32, MAILBOX);
        boxB = new Uint8Array(m.sab, 32 + MAILBOX, MAILBOX);
      }
      let host: ReturnType<typeof loadHost> = { natives: [], globals: [] };
      if (m.host) {
        try {
          host = loadHost(m.host);
        } catch (err) {
          self.postMessage({ type: "hostError", message: String((err as Error)?.message ?? err) });
        }
      }
      const problems = JSON.parse(configure({
        ...m.config,
        natives: host.natives,
        globals: host.globals,
        print,
        now: () => performance.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        pause: ctrl ? pause : undefined,
        poll: ctrl ? poll : undefined,
      }));
      if (problems.length) self.postMessage({ type: "hostTypes", problems });
      if (m.mode === "idle") {
        self.postMessage({ type: "ready" });
        return;
      }
      const result = JSON.parse(await run(m.mode, JSON.stringify(m.breakpoints ?? {})));
      self.postMessage({ type: "done", result });
      return;
    }
    if (m.type === "eval") {
      const result = JSON.parse(await evaluate(m.source));
      self.postMessage({ type: "eval", id: m.id, result });
    }
  } catch (err) {
    self.postMessage({ type: "crash", message: String((err as Error)?.message ?? err) });
  }
};
