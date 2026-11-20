// ─ Language worker ───────────────────────────────────────────────────────────
// rhue-lsp's features in wasm, off the main thread so typing never waits on it

import init, { Lang, rhue_version, token_legend } from "./wasm/rhue_playground.js";

let lang: Lang | undefined;

self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data as { id: number; method: string; args: unknown[] };
  try {
    if (method === "init") {
      await init({ module_or_path: args[0] as WebAssembly.Module });
      lang = new Lang();
      self.postMessage({ id, result: { legend: JSON.parse(token_legend()), version: rhue_version() } });
      return;
    }
    if (!lang) throw new Error("not started yet");
    const fn = (lang as any)[method];
    if (typeof fn !== "function") throw new Error(`no ${method}`);
    self.postMessage({ id, result: fn.apply(lang, args) });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
