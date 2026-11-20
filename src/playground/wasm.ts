// ─ Wasm and workers ──────────────────────────────────────────────────────────
// the module gets compiled once on the page and handed to every worker, so a
// new run worker is ready in a few ms instead of recompiling 2.5 MB each time

import wasmUrl from "./wasm/rhue_playground_bg.wasm?url";

let compiled: Promise<WebAssembly.Module> | undefined;

export function wasmModule() {
  compiled ??= (async () => {
    const res = fetch(wasmUrl);
    try {
      return await WebAssembly.compileStreaming(res);
    } catch {
      // servers that don't say application/wasm
      return WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer());
    }
  })();
  return compiled;
}

// ─ Language client ───────────────────────────────────────────────────────────

export type Legend = { types: string[]; modifiers: string[] };

export class LangClient {
  private worker = new Worker(new URL("./lang.worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  ready: Promise<{ legend: Legend; version: string }>;

  constructor() {
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const w = this.waiting.get(id);
      if (!w) return;
      this.waiting.delete(id);
      if (error !== undefined) w.fail(new Error(error));
      else w.ok(result);
    };
    this.ready = wasmModule().then((m) => this.call("init", m));
  }

  private call(method: string, ...args: unknown[]): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.worker.postMessage({ id, method, args });
    });
  }

  // everything the lang worker returns is json text, this parses it on the way out
  private async json<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    return JSON.parse(await this.call(method, ...args));
  }

  async setFile(path: string, text: string) { await this.ready; return this.call("set_file", path, text); }
  async removeFile(path: string) { await this.ready; return this.call("remove_file", path); }
  async setHost(decls: { name: string; type: string }[]) { await this.ready; return this.call("set_host", JSON.stringify(decls)); }
  async setMode(mode: string) { await this.ready; return this.call("set_mode", mode); }
  async disassemble(path: string, fold: boolean): Promise<string> { await this.ready; return this.call("disassemble", path, fold); }

  diagnostics = (path: string) => this.json<any[]>("diagnostics", path);
  hover = (path: string, line: number, col: number) => this.json<any>("hover", path, line, col);
  completion = (path: string, line: number, col: number) => this.json<any[]>("completion", path, line, col);
  signatureHelp = (path: string, line: number, col: number) => this.json<any>("signature_help", path, line, col);
  definition = (path: string, line: number, col: number) => this.json<any>("definition", path, line, col);
  references = (path: string, line: number, col: number) => this.json<any[]>("references", path, line, col);
  prepareRename = (path: string, line: number, col: number) => this.json<any>("prepare_rename", path, line, col);
  rename = (path: string, line: number, col: number, name: string) => this.json<any>("rename", path, line, col, name);
  inlayHints = (path: string, from: number, to: number) => this.json<any[]>("inlay_hints", path, from, to);
  codeActions = (path: string, sl: number, sc: number, el: number, ec: number) => this.json<any[]>("code_actions", path, sl, sc, el, ec);
  semanticTokens = (path: string) => this.json<{ data: number[] } | null>("semantic_tokens", path);
  symbols = (path: string) => this.json<any[]>("symbols", path);
  format = (path: string) => this.json<any[] | null>("format", path);
}
