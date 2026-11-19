// ─ Content ───────────────────────────────────────────────────────────────────
// Reads content/ (what scripts/sync-content.ts pulled out of the rhue repo) at
// build time and hands it to the app as `virtual:rhue-content`. Markdown gets
// rendered here and code gets highlighted here, so the browser ships HTML and
// no markdown parser or shiki.
//
// Anything malformed fails the build with the file and the reason. Better than
// a blank section on rhue.dev.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Marked, type Token, type Tokens } from "marked";
import { createCssVariablesTheme, createHighlighter, type Highlighter } from "shiki";
import type { Plugin, ViteDevServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const CONTENT = join(ROOT, "content");
const SAMPLES = join(ROOT, "src", "samples");

const VIRTUAL = "virtual:rhue-content";

// home page code tabs, in order
const SAMPLE_FILES = [
  { id: "host", label: "Rust host", file: "main.rs" },
  { id: "classes", label: "Classes", file: "account.rhue" },
  { id: "types", label: "Types", file: "cart.rhue" },
  { id: "tasks", label: "Tasks", file: "npc.rs" },
];

// ─ Highlighting ──────────────────────────────────────────────────────────────

// colours come from --shiki-* vars in site.css, so code follows the theme switch
const theme = createCssVariablesTheme({ name: "rhue", variablePrefix: "--shiki-", fontStyle: true });

const LANG_ALIAS: Record<string, string> = {
  rhue: "luau", lua: "luau", luau: "luau",
  rs: "rust", rust: "rust",
  sh: "bash", bash: "bash", shell: "bash", console: "bash",
  ps: "powershell", ps1: "powershell", powershell: "powershell", pwsh: "powershell",
  toml: "toml", json: "json", jsonc: "json",
};

let highlighter: Highlighter | undefined;

async function getHighlighter() {
  highlighter ??= await createHighlighter({
    themes: [theme],
    langs: ["rust", "luau", "toml", "json", "bash", "powershell"],
  });
  return highlighter;
}

function highlight(hl: Highlighter, code: string, lang: string | undefined) {
  const l = LANG_ALIAS[(lang ?? "").toLowerCase()] ?? "text";
  return hl.codeToHtml(code.replace(/\n$/, ""), { lang: l, theme: "rhue" });
}

// ─ Markdown ──────────────────────────────────────────────────────────────────

export const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*_]/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function makeMarked(hl: Highlighter) {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      code({ text, lang }: Tokens.Code) {
        // ```mermaid stays as source, the page draws it (Prose.tsx). the <pre> is what shows until then
        if ((lang ?? "").toLowerCase() === "mermaid") {
          return `<div class="md-mermaid aa-scroll" data-src="${escapeHtml(text)}"><pre>${escapeHtml(text)}</pre></div>\n`;
        }
        return `<div class="md-code aa-scroll">${highlight(hl, text, lang)}</div>\n`;
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(inner);
        return `<h${depth} id="${id}"><a class="md-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const ext = /^https?:\/\//.test(href);
        // repo-relative links (docs/DESIGN.md, CHANGELOG.md) go to the matching page
        const mapped = REPO_LINKS[href] ?? href;
        const t = title ? ` title="${title}"` : "";
        return `<a href="${mapped}"${t}${ext ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
    },
  });
  return md;
}

const REPO_LINKS: Record<string, string> = {
  "docs/DESIGN.md": "/design",
  "DESIGN.md": "/design",
  "CHANGELOG.md": "/changelog",
};

// lists where every item opens with **Label** become titled cards, and ✅ lists become milestone lists.
// done on the html so marked's own list rendering stays untouched
function decorate(html: string) {
  // a blank line anywhere in the list makes marked wrap every item in <p>, hence the (<p>)?
  html = html.replace(/<ul>\n((?:<li>(?:<p>)?<strong>[\s\S]*?<\/li>\n)+)<\/ul>/g, (all, items: string) => {
    const lis = items.match(/<li>[\s\S]*?<\/li>\n/g) ?? [];
    if (!lis.every((li) => /^<li>(<p>)?<strong>/.test(li))) return all;
    const out = lis.map((li) => {
      const label = /^<li>(?:<p>)?<strong>([\s\S]*?)<\/strong>/.exec(li)?.[1] ?? "";
      return li.replace("<li>", `<li class="md-def" id="d-${slug(label).slice(0, 60)}">`);
    });
    return `<ul class="md-defs">\n${out.join("")}</ul>`;
  });
  html = html.replace(/<ol>\n([\s\S]*?)<\/ol>/g, (all, items: string) => {
    if (!items.includes("✅")) return all;
    // text goes in a span so the number and the mark can sit beside it in a row
    const out = items
      .replace(/<li>(✅\s*)?/g, (_m, done) => (done ? '<li class="md-done"><span>' : '<li class="md-todo"><span>'))
      .replace(/<\/li>/g, "</span></li>");
    return `<ol class="md-milestones">\n${out}</ol>`;
  });
  return html;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plain = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ─ Loading ───────────────────────────────────────────────────────────────────

class ContentError extends Error {
  constructor(file: string, why: string) {
    super(`content/${file}: ${why}`);
  }
}

const has = (rel: string) => existsSync(join(CONTENT, rel));
const read = (rel: string) => readFileSync(join(CONTENT, rel), "utf8");

function readJson(rel: string): unknown {
  try {
    return JSON.parse(read(rel));
  } catch (e) {
    throw new ContentError(rel, `isn't valid JSON (${(e as Error).message})`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (o: Record<string, unknown>, k: string, file: string) => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ContentError(file, `"${k}" should be a string`);
  return v;
};
const reqStr = (o: Record<string, unknown>, k: string, file: string) => {
  const v = optStr(o, k, file);
  if (!v) throw new ContentError(file, `"${k}" is required`);
  return v;
};

// ─ Design Notes ──────────────────────────────────────────────────────────────

function loadDesign(md: Marked) {
  const src = read("DESIGN.md");
  const tokens = md.lexer(src);
  let title = "Design notes";
  let intro = "";
  // pull the h1 and the paragraph under it out, the page has its own header for those
  const h1 = tokens.findIndex((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1);
  if (h1 >= 0) {
    title = (tokens[h1] as Tokens.Heading).text;
    const next = tokens.slice(h1 + 1).find((t) => t.type !== "space");
    if (next?.type === "paragraph") {
      intro = md.parseInline((next as Tokens.Paragraph).text) as string;
      tokens.splice(tokens.indexOf(next), 1);
    }
    tokens.splice(h1, 1);
  }
  const toc = tokens
    .filter((t): t is Tokens.Heading => t.type === "heading" && t.depth === 2)
    .map((t) => ({ id: slug(md.parseInline(t.text) as string), text: plain(md.parseInline(t.text) as string) }));
  const html = decorate(md.parser(tokens));
  const decisions = (html.match(/class="md-def"/g) ?? []).length;
  return { title, intro, toc, html, decisions };
}

// ─ Changelog ─────────────────────────────────────────────────────────────────

export interface Entry {
  slug: string;
  tag: string;
  title: string;
  version?: string;
  date?: string;
  summary: string;
  html: string;
}

function summaryOf(html: string) {
  const li = /<li[^>]*>([\s\S]*?)<\/li>/.exec(html)?.[1] ?? /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  const text = plain(li).replace(/^(Feat|Fix|Chore|Docs|Perf):\s*/i, "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? text.slice(0, 147).replace(/\s+\S*$/, "") + "…" : text;
}

// preferred: changelog/index.json plus one markdown file per release
function loadChangelogFolder(md: Marked) {
  const file = "changelog/index.json";
  const data = readJson(file);
  const list = Array.isArray(data) ? data : isObj(data) ? data.entries : undefined;
  if (!Array.isArray(list)) throw new ContentError(file, 'expected { "entries": [...] }');
  const entries: Entry[] = list.map((raw, i) => {
    if (!isObj(raw)) throw new ContentError(file, `entry ${i} isn't an object`);
    const name = reqStr(raw, "file", file);
    if (!/^[\w.-]+\.md$/.test(name)) throw new ContentError(file, `entry ${i}: "file" should be a plain .md file name, got ${name}`);
    if (!has("changelog/" + name)) throw new ContentError(file, `entry ${i}: changelog/${name} doesn't exist`);
    const html = decorate(md.parse(read("changelog/" + name)) as string);
    const base = name.replace(/\.md$/, "");
    return {
      slug: slug(base),
      tag: optStr(raw, "tag", file) ?? base.toUpperCase(),
      title: optStr(raw, "title", file) ?? base,
      version: optStr(raw, "version", file),
      date: optStr(raw, "date", file),
      summary: optStr(raw, "summary", file) ?? summaryOf(html),
      html,
    };
  });
  return { source: "folder" as const, intro: "", entries };
}

// fallback until the rhue repo has changelog/: split CHANGELOG.md on its "### Thing (milestone N)" headings
function loadChangelogFile(md: Marked) {
  const tokens = md.lexer(read("CHANGELOG.md"));
  const intro: Token[] = [];
  const entries: { meta: Omit<Entry, "html" | "summary">; tokens: Token[] }[] = [];
  let version: string | undefined;
  let date: string | undefined;
  let seenVersion = false;

  for (const t of tokens) {
    if (t.type === "heading" && (t as Tokens.Heading).depth === 1) continue;
    if (t.type === "heading" && (t as Tokens.Heading).depth === 2) {
      // "## [0.1.0] - Unreleased"
      const m = /^\[?([^\]\s]+)\]?\s*(?:[-–]\s*(.+))?$/.exec((t as Tokens.Heading).text.trim());
      version = m?.[1];
      date = m?.[2];
      seenVersion = true;
      continue;
    }
    if (t.type === "heading" && (t as Tokens.Heading).depth === 3) {
      const text = (t as Tokens.Heading).text;
      const m = /^(.*?)\s*\(milestone (\d+)\)\s*$/i.exec(text);
      if (m) {
        entries.push({ meta: { slug: "m" + m[2], tag: "M" + m[2], title: m[1], version, date }, tokens: [] });
        continue;
      }
      // "### Changed" and friends belong to the milestone above them
      const cur = entries[entries.length - 1];
      if (cur) { cur.tokens.push({ ...(t as Tokens.Heading), depth: 4 }); continue; }
    }
    if (!seenVersion) intro.push(t);
    else entries[entries.length - 1]?.tokens.push(t);
  }

  const links = (tokens as unknown as { links: Record<string, unknown> }).links;
  const render = (ts: Token[]) => decorate(md.parser(Object.assign(ts, { links }) as never));
  return {
    source: "CHANGELOG.md" as const,
    intro: render(intro),
    entries: entries.map((e) => {
      const html = render(e.tokens);
      return { ...e.meta, html, summary: summaryOf(html) } satisfies Entry;
    }),
  };
}

function loadChangelog(md: Marked) {
  if (has("changelog/index.json")) {
    const folder = loadChangelogFolder(md);
    if (folder.entries.length) return folder;
  }
  if (has("CHANGELOG.md")) return loadChangelogFile(md);
  return { source: "none" as const, intro: "", entries: [] as Entry[] };
}

// ─ What's Next ───────────────────────────────────────────────────────────────

function loadNext(md: Marked) {
  const file = "changelog/next.json";
  if (!has(file)) return [];
  const data = readJson(file);
  const list = Array.isArray(data) ? data : isObj(data) ? data.items : undefined;
  if (!Array.isArray(list)) throw new ContentError(file, 'expected { "items": [...] }');
  return list.map((raw, i) => {
    if (!isObj(raw)) throw new ContentError(file, `item ${i} isn't an object`);
    return {
      tag: optStr(raw, "tag", file) ?? "",
      title: reqStr(raw, "title", file),
      body: md.parseInline(optStr(raw, "body", file) ?? "") as string,
    };
  });
}

// ─ Benchmarks ────────────────────────────────────────────────────────────────

function loadBench() {
  const file = "bench.json";
  if (!has(file)) return null;
  const data = readJson(file);
  if (!isObj(data) || !Array.isArray(data.rows)) throw new ContentError(file, 'expected { "rows": [...] }');
  const num = (o: Record<string, unknown>, k: string, i: number) => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !(v > 0)) throw new ContentError(file, `row ${i}: "${k}" should be a positive number of ms`);
    return v;
  };
  return {
    measured: optStr(data, "measured", file) ?? "",
    note: optStr(data, "note", file) ?? "",
    luau: optStr(data, "luau", file) ?? "Luau",
    rhai: optStr(data, "rhai", file) ?? "Rhai",
    rows: data.rows.map((raw, i) => {
      if (!isObj(raw)) throw new ContentError(file, `row ${i} isn't an object`);
      const rhue = num(raw, "rhue", i);
      if (rhue === null) throw new ContentError(file, `row ${i}: "rhue" is required`);
      return { name: reqStr(raw, "name", file), stresses: optStr(raw, "stresses", file) ?? "", rhue, luau: num(raw, "luau", i), rhai: num(raw, "rhai", i) };
    }),
  };
}

// ─ Meta ──────────────────────────────────────────────────────────────────────

function loadMeta() {
  const meta = has("meta.json") ? readJson("meta.json") : {};
  if (!isObj(meta)) throw new ContentError("meta.json", "should be an object");
  return {
    version: optStr(meta, "version", "meta.json") ?? "0.1.0",
    repo: optStr(meta, "repo", "meta.json") ?? "rhuelang/rhue",
    commit: optStr(meta, "commit", "meta.json") ?? null,
    syncedAt: optStr(meta, "syncedAt", "meta.json") ?? null,
  };
}

// ─ Build ─────────────────────────────────────────────────────────────────────

export async function buildContent() {
  const hl = await getHighlighter();
  const md = makeMarked(hl);
  const changelog = loadChangelog(md);
  const meta = loadMeta();
  return {
    meta: { ...meta, milestone: changelog.entries[0]?.tag ?? null },
    design: loadDesign(md),
    changelog,
    next: loadNext(md),
    bench: loadBench(),
    samples: SAMPLE_FILES.map((s) => ({
      ...s,
      html: highlight(hl, readFileSync(join(SAMPLES, s.file), "utf8"), s.file.endsWith(".rs") ? "rust" : "luau"),
    })),
  };
}

export type RhueContent = Awaited<ReturnType<typeof buildContent>>;

// three modules so the home page doesn't carry the whole design doc around:
//   virtual:rhue-content            meta, roadmap, bench, samples, changelog summaries
//   virtual:rhue-content/design     the design notes
//   virtual:rhue-content/changelog  full changelog entries
const MODULES = [VIRTUAL, VIRTUAL + "/design", VIRTUAL + "/changelog"];

function pick(c: RhueContent, id: string) {
  if (id.endsWith("/design")) return c.design;
  if (id.endsWith("/changelog")) return { intro: c.changelog.intro, source: c.changelog.source, entries: c.changelog.entries };
  return {
    meta: c.meta,
    next: c.next,
    bench: c.bench,
    samples: c.samples,
    changelog: { source: c.changelog.source, entries: c.changelog.entries.map(({ html: _, ...e }) => e) },
  };
}

export function rhueContent(): Plugin {
  let cached: Promise<RhueContent> | null = null;
  const get = () => (cached ??= buildContent());
  return {
    name: "rhue-content",
    resolveId: (id) => (MODULES.includes(id) ? "\0" + id : undefined),
    async load(id) {
      if (!id.startsWith("\0" + VIRTUAL)) return;
      this.addWatchFile(CONTENT);
      return `export default ${JSON.stringify(pick(await get(), id.slice(1)))};`;
    },
    configureServer(server: ViteDevServer) {
      // edit content/ or a sample, page reloads with it
      server.watcher.add([CONTENT, SAMPLES]);
      const reload = (file: string) => {
        if (!file.startsWith(CONTENT) && !file.startsWith(SAMPLES)) return;
        cached = null;
        for (const id of MODULES) {
          const mod = server.moduleGraph.getModuleById("\0" + id);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
  };
}
