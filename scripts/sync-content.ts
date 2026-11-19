// ─ Sync ──────────────────────────────────────────────────────────────────────
// Pulls what the site shows out of the rhue repo and into content/.
//
//   bun run sync                      reads ../rhue (a checkout next to this one)
//   RHUE_DIR=path bun run sync        reads some other checkout
//   RHUE_REPO=owner/name bun run sync reads GitHub instead (RHUE_REF, GITHUB_TOKEN for private repos)
//
// Files the rhue repo doesn't have yet are left alone here, so the committed
// copies in content/ keep the site building.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const CONTENT = join(ROOT, "content");
const BRAND = join(ROOT, "public", "brand");

const REMOTE = process.env.RHUE_REPO;
const REF = process.env.RHUE_REF ?? "main";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const DIR = resolve(ROOT, process.env.RHUE_DIR ?? "../rhue");

// ─ Sources ───────────────────────────────────────────────────────────────────

interface Source {
  name: string;
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
  commit(): Promise<string | null>;
}

function local(dir: string): Source {
  return {
    name: dir,
    async read(p) {
      const f = join(dir, p);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },
    async list(d) {
      const f = join(dir, d);
      return existsSync(f) ? readdirSync(f) : [];
    },
    async commit() {
      const r = await $`git -C ${dir} rev-parse HEAD`.quiet().nothrow();
      return r.exitCode === 0 ? r.text().trim() : null;
    },
  };
}

function github(repo: string, ref: string): Source {
  const headers: Record<string, string> = { "User-Agent": "rhue-site-sync", "X-GitHub-Api-Version": "2022-11-28" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const api = (p: string) => `https://api.github.com/repos/${repo}/${p}`;
  return {
    name: `${repo}@${ref}`,
    async read(p) {
      const r = await fetch(api(`contents/${p}?ref=${ref}`), { headers: { ...headers, Accept: "application/vnd.github.raw" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub said ${r.status} for ${p}${r.status === 401 || r.status === 403 ? " (token?)" : ""}`);
      return r.text();
    },
    async list(d) {
      const r = await fetch(api(`contents/${d}?ref=${ref}`), { headers: { ...headers, Accept: "application/vnd.github+json" } });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`GitHub said ${r.status} listing ${d}`);
      return ((await r.json()) as { name: string }[]).map((e) => e.name);
    },
    async commit() {
      const r = await fetch(api(`commits/${ref}`), { headers: { ...headers, Accept: "application/vnd.github+json" } });
      return r.ok ? ((await r.json()) as { sha: string }).sha : null;
    },
  };
}

// ─ Copying ───────────────────────────────────────────────────────────────────

function put(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const src: Source = REMOTE ? github(REMOTE, REF) : local(DIR);
if (!REMOTE && !existsSync(DIR)) {
  console.error(`no rhue checkout at ${DIR}. set RHUE_DIR, or RHUE_REPO to read GitHub`);
  process.exit(1);
}
console.log(`syncing from ${src.name}`);

let copied = 0;
let skipped = 0;
async function take(from: string, to: string, required = false) {
  const text = await src.read(from);
  if (text === null) {
    if (required) throw new Error(`${from} is missing in ${src.name}, the site can't build without it`);
    console.log(`  - ${from} (not there yet, keeping ours)`);
    skipped++;
    return null;
  }
  put(to, text);
  console.log(`  + ${from}`);
  copied++;
  return text;
}

await take("docs/DESIGN.md", join(CONTENT, "DESIGN.md"), true);
await take("CHANGELOG.md", join(CONTENT, "CHANGELOG.md"));

// changelog/ folder: the index, the roadmap and whatever .md files the index points at
const index = await take("changelog/index.json", join(CONTENT, "changelog", "index.json"));
await take("changelog/next.json", join(CONTENT, "changelog", "next.json"));
if (index) {
  const files = new Set<string>();
  try {
    const data = JSON.parse(index);
    for (const e of Array.isArray(data) ? data : data.entries ?? []) if (typeof e?.file === "string") files.add(e.file);
  } catch {
    // the content plugin reports bad json with a proper message, don't double up here
  }
  // also anything else sitting in the folder, so a half-written entry still shows up in dev
  for (const name of await src.list("changelog")) if (name.endsWith(".md")) files.add(name);
  for (const f of files) await take(`changelog/${f}`, join(CONTENT, "changelog", f));
}

await take("bench/results.json", join(CONTENT, "bench.json"));

const logo = await take("assets/Logo.svg", join(BRAND, "logo.svg"));
const icon = await take("assets/Icon.svg", join(BRAND, "icon.svg"));
if (icon) put(join(ROOT, "public", "favicon.svg"), icon);
void logo;

// version from the workspace Cargo.toml, commit for the footer
const cargo = (await src.read("Cargo.toml")) ?? "";
const version = /\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1]
  ?? /\[package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
const commit = await src.commit();
const meta = {
  version: version ?? "0.1.0",
  repo: REMOTE ?? process.env.RHUE_PUBLIC_REPO ?? "gyfdb/rhue",
  commit,
  syncedAt: new Date().toISOString(),
};
put(join(CONTENT, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.log(`done: ${copied} copied, ${skipped} kept, v${meta.version}${commit ? " @ " + commit.slice(0, 7) : ""}`);
