// ─ Runner ────────────────────────────────────────────────────────────────────
// owns the run worker. a run gets a fresh worker (stopping = terminating it),
// and the last one sticks around so the console can poke at what it left

import { wasmModule } from "./wasm";
import type { HostDecl } from "./host";

export type Mode = "run" | "debug" | "profile";

export type Settings = {
  typeMode: "nocheck" | "nonstrict" | "strict";
  foldConstants: boolean;
  instructionLimit: number | null;
  memoryLimit: number | null;
  gcStress: boolean;
  tasks: boolean;
};

export type Bp = { line: number; enabled: boolean; condition?: string; hit?: string; log?: string };

export type Pos = { line: number; col: number };
export type RunError = {
  message: string;
  rendered: string;
  file: string | null;
  start: Pos | null;
  end: Pos | null;
  stopped: boolean;
  interrupted: boolean;
};

export type Variable = { name: string; value: string; type: string; ref: number | null };
export type Scope = { name: string; variables: Variable[] };
export type Frame = { function: string; source: string; file: string | null; line: number };
export type Stopped = { reason: string; file: string; line: number; frames: Frame[]; scopes: Scope[] };

export type Profile = {
  lines: { file: string; line: number; hits: number; ms: number }[];
  functions: { function: string; file: string; line: number; calls: number }[];
  totalLines: number;
};

export type Result = {
  elapsedMs: number;
  values?: string[];
  error?: RunError;
  moreErrors?: string[];
  suspended?: boolean;
  memory: number;
  heap: { bytes: number; strings: number; tables: number; functions: number; userdata: number; threads: number; buffers: number; collections: number };
  host: { name: string; calls: number; ms: number }[];
  profile?: Profile;
};

export type Events = {
  print(text: string, kind: string): void;
  stopped(s: Stopped): void;
  done(r: Result | null, crash?: string): void;
  hostError(message: string): void;
  hostTypes(problems: { name: string; message: string }[]): void;
};

const MAILBOX = 64 * 1024;
const enc = new TextEncoder();

/** Debugging blocks the worker with Atomics.wait, which needs isolation */
export const canDebug = () => typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;

function newWorker() {
  return new Worker(new URL("./run.worker.ts", import.meta.url), { type: "module" });
}

export type StartOptions = {
  files: { path: string; text: string }[];
  main: string;
  settings: Settings;
  host: string | null;
  breakpoints: Record<string, Bp[]>;
};

/** Breakpoints the way the wasm side wants them, disabled ones left out */
export function wireBreakpoints(bps: Record<string, Bp[]>) {
  const out: Record<string, Omit<Bp, "enabled">[]> = {};
  for (const [file, list] of Object.entries(bps)) {
    const on = list.filter((b) => b.enabled).map(({ enabled: _, ...b }) => b);
    if (on.length) out[file] = on;
  }
  return out;
}

export class Session {
  readonly mode: Mode | "idle";
  private worker = newWorker();
  private sab?: SharedArrayBuffer;
  private ctrl?: Int32Array;
  private boxA?: Uint8Array;
  private boxB?: Uint8Array;
  private nextId = 1;
  private replies = new Map<number, (v: any) => void>();
  private evals = new Map<number, (v: any) => void>();
  running = true;
  paused = false;

  constructor(mode: Mode | "idle", opts: StartOptions, private on: Events) {
    this.mode = mode;
    if (mode === "debug" && canDebug()) {
      this.sab = new SharedArrayBuffer(32 + MAILBOX * 2);
      this.ctrl = new Int32Array(this.sab, 0, 8);
      this.boxA = new Uint8Array(this.sab, 32, MAILBOX);
      this.boxB = new Uint8Array(this.sab, 32 + MAILBOX, MAILBOX);
    }
    this.worker.onmessage = (e) => this.message(e.data);
    this.worker.onerror = (e) => {
      this.running = false;
      this.on.done(null, e.message || "the run worker crashed");
    };
    void wasmModule().then((module) =>
      this.worker.postMessage({
        type: "start",
        module,
        sab: this.sab,
        mode,
        host: opts.host,
        breakpoints: wireBreakpoints(opts.breakpoints),
        config: {
          files: opts.files,
          main: opts.main,
          foldConstants: opts.settings.foldConstants,
          typeMode: opts.settings.typeMode,
          instructionLimit: opts.settings.instructionLimit,
          memoryLimit: opts.settings.memoryLimit,
          gcStress: opts.settings.gcStress,
          tasks: opts.settings.tasks,
        },
      }),
    );
  }

  private message(m: any) {
    switch (m.type) {
      case "print":
        this.on.print(m.text, m.kind);
        break;
      case "debug": {
        const msg = JSON.parse(m.msg);
        if (msg.type === "stopped") {
          this.paused = true;
          this.on.stopped(msg);
        } else if (msg.type === "reply") {
          this.replies.get(msg.id)?.(msg);
          this.replies.delete(msg.id);
        }
        break;
      }
      case "ready":
        this.running = false;
        break;
      case "done":
        this.running = false;
        this.paused = false;
        this.on.done(m.result);
        break;
      case "eval":
        this.evals.get(m.id)?.(m.result);
        this.evals.delete(m.id);
        break;
      case "hostError":
        this.on.hostError(m.message);
        break;
      case "hostTypes":
        this.on.hostTypes(m.problems);
        break;
      case "crash":
        this.running = false;
        this.paused = false;
        this.on.done(null, m.message);
        break;
    }
  }

  // ─ Debugger commands ───────────────────────────────────────────────────────

  private send(cmd: object) {
    if (!this.ctrl || !this.boxA) return;
    const bytes = enc.encode(JSON.stringify(cmd));
    this.boxA.set(bytes.subarray(0, MAILBOX));
    Atomics.store(this.ctrl, 1, Math.min(bytes.length, MAILBOX));
    Atomics.store(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 0);
  }

  // one command in the mailbox at a time. requests wait for the one before to
  // get its reply, and resuming waits for all of them
  private chain: Promise<unknown> = Promise.resolve();

  private request<T>(cmd: object): Promise<T> {
    if (!this.paused) return Promise.reject(new Error("not stopped"));
    const next = this.chain.then(
      () =>
        new Promise<T>((ok) => {
          if (!this.paused) return ok(Promise.reject(new Error("not stopped")) as T);
          const id = this.nextId++;
          this.replies.set(id, ok);
          this.send({ ...cmd, id });
        }),
    );
    this.chain = next.catch(() => {});
    return next;
  }

  resume(how: "continue" | "stepIn" | "stepOver" | "stepOut") {
    if (!this.paused) return;
    this.paused = false;
    this.chain = this.chain.then(() => this.send({ cmd: how }));
  }

  evalIn(expr: string, frame: number) {
    return this.request<{ result?: Variable; error?: string }>({ cmd: "eval", expr, frame });
  }

  scopes(frame: number) {
    return this.request<{ scopes: Scope[] }>({ cmd: "scopes", frame }).then((r) => r.scopes);
  }

  expand(ref: number) {
    return this.request<{ children: Variable[] }>({ cmd: "expand", ref }).then((r) => r.children);
  }

  pause() {
    if (this.ctrl) Atomics.store(this.ctrl, 4, 1);
  }

  /** Picked up at the script's next line, stopped or not */
  setBreakpoints(bps: Record<string, Bp[]>) {
    if (!this.ctrl || !this.boxB) return;
    const bytes = enc.encode(JSON.stringify(wireBreakpoints(bps)));
    this.boxB.set(bytes.subarray(0, MAILBOX));
    Atomics.store(this.ctrl, 3, Math.min(bytes.length, MAILBOX));
    Atomics.add(this.ctrl, 2, 1);
  }

  /** Ends the script. A debug session gets a chance to stop cleanly first */
  stop() {
    if (!this.running) return;
    if (this.ctrl && this.mode === "debug") {
      Atomics.store(this.ctrl, 5, 1);
      if (this.paused) {
        this.paused = false;
        this.chain = this.chain.then(() => this.send({ cmd: "stop" }));
      }
      setTimeout(() => this.running && this.kill(), 400);
      return;
    }
    this.kill();
  }

  private kill() {
    this.worker.terminate();
    const was = this.running;
    this.running = false;
    this.paused = false;
    if (was) this.on.done(null, "stopped");
  }

  dispose() {
    this.worker.terminate();
  }

  // ─ Console ─────────────────────────────────────────────────────────────────

  /** Evaluates in what the last run left behind (not while it's running) */
  evaluate(source: string): Promise<{ values?: string[]; error?: RunError }> {
    const id = this.nextId++;
    return new Promise((ok) => {
      this.evals.set(id, ok);
      this.worker.postMessage({ type: "eval", id, source });
    });
  }
}

// ─ host.js declarations ──────────────────────────────────────────────────────
// a throwaway worker runs host.js just to learn what it declares

export async function readHost(source: string): Promise<{ decls: HostDecl[]; error?: string }> {
  const w = newWorker();
  try {
    return await new Promise((ok) => {
      const timer = setTimeout(() => ok({ decls: [], error: "host.js took more than 2s just to load" }), 2000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        if (e.data.type === "host") ok({ decls: e.data.decls });
        else ok({ decls: [], error: e.data.message ?? "host.js failed" });
      };
      w.postMessage({ type: "host", id: 0, source });
    });
  } finally {
    w.terminate();
  }
}
