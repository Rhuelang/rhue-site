// ─ As Rust ───────────────────────────────────────────────────────────────────
// the engine the playground built, written out as the rust you'd put in your
// own app. host.js's bodies can't be translated, so they come along as comments

import type { HostDecl } from "./host";
import { parseFnType, rustType } from "./host";
import type { Settings } from "./runner";
import { MAIN } from "./store";

const rustString = (s: string) => JSON.stringify(s);

function closure(d: HostDecl) {
  const sig = parseFnType(d.type);
  const params = sig ? sig.params.filter((p) => p !== "...any").map((p, i) => `a${i}: ${rustType(p)}`) : ["args: rhue::Variadic<rhue::Value>"];
  const ret = sig ? rustType(sig.ret) : "rhue::Value";
  const body = d.async ? `async move {\n        todo!("what host.js does")\n    }` : `{\n        todo!("what host.js does")\n    }`;
  const head = `|${params.join(", ")}|${d.async ? "" : ` -> ${ret}`}`;
  // closures whose parameter types say it all don't need declare
  const typed = sig && [...sig.params, sig.ret].every((t) => rustType(t) !== "rhue::Value");
  return { code: `${head} ${body}`, needsDeclare: !!d.type && !typed };
}

function jsComment(src: string | undefined) {
  if (!src) return "";
  const lines = src.split("\n").slice(0, 12);
  return lines.map((l) => `    // ${l}`).join("\n") + (src.split("\n").length > 12 ? "\n    // ..." : "") + "\n";
}

export function asRust(settings: Settings, decls: HostDecl[], files: string[]): string {
  const hasAsync = decls.some((d) => d.async) || settings.tasks;
  const out: string[] = [];
  out.push(`// The engine the playground runs your script on, as host code. Cargo.toml:
//
//   [dependencies]
//   rhue = "2"${hasAsync ? `\n//   tokio = { version = "1", features = ["rt", "time", "macros"] }` : ""}
//
// Regenerated from the Engine panel and host.js whenever they change.
`);
  out.push(`use rhue::{CompileOptions, Engine, TypeMode};\n`);
  out.push(hasAsync ? `#[tokio::main(flavor = "current_thread")]\nasync fn main() -> Result<(), rhue::Error> {` : `fn main() -> Result<(), rhue::Error> {`);
  const mode = { nocheck: "NoCheck", nonstrict: "NonStrict", strict: "Strict" }[settings.typeMode];
  out.push(`    let mut engine = Engine::with_options(CompileOptions::new().fold_constants(${settings.foldConstants}));`);
  out.push(`    engine.set_default_type_mode(TypeMode::${mode});`);
  if (settings.instructionLimit != null) out.push(`    engine.set_instruction_limit(Some(${settings.instructionLimit.toLocaleString("en-US").replace(/,/g, "_")}));`);
  if (settings.memoryLimit != null) out.push(`    engine.set_memory_limit(Some(${settings.memoryLimit / 1024 / 1024} * 1024 * 1024));`);
  if (settings.gcStress) out.push(`    // GC stress is a testing aid, it's #[doc(hidden)] on purpose\n    engine.set_gc_stress(true);`);
  if (settings.tasks) out.push(`    engine.open_tasks();\n    engine.set_sleep(tokio::time::sleep);`);

  if (decls.length) out.push(`\n    // from host.js`);
  for (const d of decls) {
    out.push("");
    if (d.value) {
      out.push(`    engine.set_global(${rustString(d.name)}, todo!("the value host.js gave it"));`);
      if (d.type) out.push(`    engine.declare(${rustString(d.name)}, ${rustString(d.type)})?;`);
      continue;
    }
    const c = closure(d);
    out.push(jsComment(d.source) + `    engine.${d.async ? "register_async" : "register"}(${rustString(d.name)}, ${c.code});`);
    if (c.needsDeclare) out.push(`    engine.declare(${rustString(d.name)}, ${rustString(d.type!)})?;`);
  }

  const modules = files.filter((f) => f !== MAIN && f.endsWith(".rhue"));
  if (modules.length) out.push(`\n    // modules`);
  for (const m of modules) out.push(`    engine.add_module(${rustString(m.replace(/\.rhue$/, ""))}, include_str!(${rustString(m)}));`);

  out.push("");
  if (hasAsync) {
    out.push(`    let task = engine.spawn(${rustString(MAIN)}, include_str!(${rustString(MAIN)}))?;`);
    out.push(`    for e in engine.run_until_idle().await {\n        eprintln!("{}", e.render(true));\n    }`);
    out.push(`    println!("{:?}", task.state());`);
  } else {
    out.push(`    let values = engine.eval_named(${rustString(MAIN)}, include_str!(${rustString(MAIN)}))?;`);
    out.push(`    println!("{values:?}");`);
  }
  out.push(`    Ok(())\n}\n`);
  return out.join("\n");
}
