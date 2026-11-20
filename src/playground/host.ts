// ─ host.js ───────────────────────────────────────────────────────────────────
// the "engine side" of the playground. in a real app this is the rust code that
// builds an Engine and hands scripts things to call. here it's javascript, run
// in the same worker as the engine, and everything it adds is a real native

/** What host.js added, as the page sees it (the functions stay in the worker) */
export type HostDecl = {
  name: string;
  type?: string;
  async?: boolean;
  /** the function's js, for the "as Rust" view */
  source?: string;
  /** a value, not a function */
  value?: boolean;
};

export const HOST_FILE = "host.js";

export const HOST_TEMPLATE = `// host.js is the engine side. It runs before your script, in the same worker as
// the engine, and whatever it adds scripts can call like any other function.
//
//   host.fn(name, type?, fn)       a native, type in Luau syntax for the checker
//   host.async(name, type?, fn)    an async native, the script waits on the promise
//   host.value(name, type?, value) a global value
//
// Tables come in as arrays or objects and go back the same way. Throwing raises
// an error in the script (pcall catches it). console.log goes to Output.

host.fn("lerp", "(number, number, number) -> number", (a, b, t) => a + (b - a) * t);

host.fn("now", "() -> number", () => performance.now());

host.async("fetchScore", "(string) -> number", async (name) => {
  await host.sleep(250);
  return name.length * 100;
});

host.value("CONFIG", "{ debug: boolean, level: number }", { debug: true, level: 3 });
`;

// ─ Types ─────────────────────────────────────────────────────────────────────
// enough of luau's type syntax to turn a native's signature into rust closure
// parameters for the "as Rust" view

/** Splits on commas that aren't inside brackets or angle brackets */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "(number, string?) -> boolean" into params and a result */
export function parseFnType(ty: string | undefined): { params: string[]; ret: string } | undefined {
  if (!ty) return;
  const t = ty.trim();
  if (!t.startsWith("(")) return;
  let depth = 0;
  let close = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    if (t[i] === ")" && --depth === 0) { close = i; break; }
  }
  if (close < 0) return;
  const rest = t.slice(close + 1).trim();
  if (!rest.startsWith("->")) return;
  // named params like (x: number) keep just the type
  const params = splitTop(t.slice(1, close)).map((p) => p.replace(/^[A-Za-z_]\w*\s*:\s*/, ""));
  return { params, ret: rest.slice(2).trim() };
}

/** The rust type a closure would take or give back for a luau type */
export function rustType(luau: string): string {
  const t = luau.trim();
  if (t.endsWith("?")) return `Option<${rustType(t.slice(0, -1))}>`;
  switch (t) {
    case "number": return "f64";
    case "string": return "String";
    case "boolean": return "bool";
    case "()": case "nil": return "()";
    case "buffer": return "rhue::Buffer";
    case "vector": return "[f32; 3]";
  }
  if (/^\{\s*[^:}]+\s*\}$/.test(t)) return `Vec<${rustType(t.slice(1, -1))}>`;
  if (t.startsWith("{")) return "rhue::Table";
  if (t.startsWith("(")) return "rhue::Function";
  return "rhue::Value";
}
