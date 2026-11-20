// Builds the playground's wasm (playground/) into src/playground/wasm/.
//
//   bun run wasm                needs the wasm32-unknown-unknown target and
//                               wasm-bindgen-cli at the version Cargo.lock has
//   RHUE_BUILD_STD=1 bun run wasm   builds std from rust-src instead of the
//                               target's prebuilt one (nightly flags on stable)

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CRATE = resolve(ROOT, "playground");
const OUT = resolve(ROOT, "src/playground/wasm");
const TARGET = "wasm32-unknown-unknown";

const lock = readFileSync(resolve(CRATE, "Cargo.lock"), "utf8");
const want = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
const have = (await $`wasm-bindgen --version`.nothrow().quiet().text()).trim().split(" ")[1];
if (!have) {
  console.error(`wasm-bindgen isn't installed. cargo install wasm-bindgen-cli --version ${want} --locked`);
  process.exit(1);
}
if (want && have !== want) {
  console.error(`wasm-bindgen is ${have} but Cargo.lock wants ${want}, they have to match`);
  process.exit(1);
}

const buildStd = process.env.RHUE_BUILD_STD === "1";
const args = ["build", "--release", "--locked", "--target", TARGET];
if (buildStd) args.push("-Zbuild-std=std,panic_abort");
await $`cargo ${args}`.cwd(CRATE).env({ ...process.env, ...(buildStd ? { RUSTC_BOOTSTRAP: "1" } : {}) });

const wasm = resolve(CRATE, `target/${TARGET}/release/rhue_playground.wasm`);
if (!existsSync(wasm)) throw new Error(`cargo didn't leave ${wasm}`);
await $`wasm-bindgen --target web --out-dir ${OUT} ${wasm}`;
const size = Bun.file(resolve(OUT, "rhue_playground_bg.wasm")).size;
console.log(`playground wasm: ${(size / 1024 / 1024).toFixed(2)} MB in src/playground/wasm`);
