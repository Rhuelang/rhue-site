import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import content from "virtual:rhue-content";
import { IconButton, Pill, SegmentedButton, Table } from "../aalto";
import { LinkButton, REPO_URL } from "../components/Layout";
import { SectionNav } from "../components/SectionNav";
import { glideToId, useTitle } from "../lib/site";

const INSTALL = `rhue = { git = "${REPO_URL}" }`;

const FEATURES = [
  { icon: "code", title: "Luau syntax", body: "String interpolation, metatables and setmetatable classes, tail calls, coroutines, generic for with __iter, vectors." },
  { icon: "verified", title: "Gradual types", body: "--!strict and --!nonstrict, generics and type packs, narrowing, flow typing, read-only and write-only properties. Checked when it compiles, never at runtime." },
  { icon: "library_books", title: "Standard library", body: "table, string with Lua patterns, math, utf8, bit32, buffer, vector, debug, frozen tables, and an os that can't reach outside the sandbox." },
  { icon: "integration_instructions", title: "Embedding", body: "Typed register, #[derive(UserData)], calling scripts from Rust, natives that pause scripts, separate environments for plugins, serde, instruction and memory limits." },
  { icon: "schedule", title: "Async", body: "Register async Rust functions and scripts just sit there until they're done. eval_async, task.wait on real time, and you can stop a script from any thread." },
  { icon: "package_2", title: "Modules and chunks", body: "require with typed modules from the host, plus saved bytecode that has to get past a verifier before it runs." },
  { icon: "terminal", title: "Tooling", body: "The rhue CLI with a REPL, test runner and formatter, a language server and a debug adapter." },
  { icon: "speed", title: "Speed", body: "Register bytecode, inline caches, table templates, fast paths for builtins. No unsafe anywhere in the crates either." },
];

const TOOLS = [
  { icon: "terminal", name: "rhue", what: "Runs files, -e snippets and compiled chunks. On its own it's a REPL, and locals stick around between entries.", cmd: `cargo install --git ${REPO_URL} rhue-cli` },
  { icon: "science", name: "rhue test", what: "Finds *_test.rhue files and runs each in a fresh engine, with typed expect() matchers.", cmd: "rhue test --filter cart" },
  { icon: "format_align_left", name: "rhue fmt", what: "Keeps your line breaks and comments. If it would change your program it refuses instead.", cmd: "rhue fmt --check src/*.rhue" },
  { icon: "lightbulb", name: "rhue-lsp", what: "Diagnostics as you type, hover, inlay hints, quick fixes, rename, definitions and references across modules.", cmd: "cargo install --path crates/rhue-lsp" },
  { icon: "bug_report", name: "rhue-dap", what: "Breakpoints with conditions, hit counts and logpoints, stepping, watch expressions, expandable tables.", cmd: "cargo install --path crates/rhue-dap" },
];

const SECTIONS = [
  { id: "features", label: "Features" },
  { id: "performance", label: "Performance" },
  { id: "changes", label: "Changes" },
  { id: "tooling", label: "Tooling" },
  { id: "roadmap", label: "Roadmap" },
];

const ms = (n: number | null) => (n === null ? "–" : n >= 100 ? String(Math.round(n)) : n.toFixed(1));

// "2.6× faster" relative to rhue, from the other engine's point of view
function ratio(rhue: number, other: number | null) {
  if (other === null) return "";
  const r = other < rhue ? rhue / other : other / rhue;
  return `${r < 10 ? r.toFixed(1) : Math.round(r)}× ${other < rhue ? "faster" : "slower"}`;
}

export default function Home() {
  useTitle(() => "");
  const [tab, setTab] = createSignal(content.samples[0].id);
  const sample = createMemo(() => content.samples.find((s) => s.id === tab()) ?? content.samples[0]);
  const [copied, setCopied] = createSignal(false);

  const copy = async () => {
    try { await navigator.clipboard.writeText(INSTALL); } catch { /* no clipboard, nothing to do */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // landing on /#performance from another page
  onMount(() => { if (location.hash) requestAnimationFrame(() => glideToId(location.hash.slice(1))); });

  const bench = content.bench;
  const recent = content.changelog.entries.slice(0, 3);

  return (
    <>
      {/* ─ Hero ─ */}
      <section class="hero">
        <div class="wrap">
          <div class="hero-copy">
            <Pill variant="dashed">
              v{content.meta.version}
              <Show when={content.meta.milestone}> · {content.meta.milestone}</Show>
              {" "}· not on crates.io yet
            </Pill>
            <h1>Luau-style scripting, <span>embedded in Rust</span></h1>
            <p class="lead">
              Rhue looks like Luau (syntax, gradual typing with <code class="ic">--!strict</code>), embeds about as easily as Rhai,
              and compiles to register bytecode run by a VM. Nothing gets tree-walked.
            </p>
            <div class="hero-actions">
              <LinkButton href="#quick-start" variant="primary" size="l" icon="bolt" onClick={(e) => { if (glideToId("quick-start")) e.preventDefault(); }}>Get started</LinkButton>
              <LinkButton href={REPO_URL} external size="l" icon="code">View on GitHub</LinkButton>
              <LinkButton href="/design" variant="ghost" size="l">Design notes</LinkButton>
            </div>
            <div id="quick-start" class="copyline">
              <span class="copyline-label">Cargo.toml</span>
              <div class="copyline-box">
                <code class="aa-scroll">{INSTALL}</code>
                <IconButton icon={copied() ? "check" : "content_copy"} label="Copy dependency line" size="m" onClick={copy} />
              </div>
            </div>
          </div>

          <div class="card codecard">
            <div class="codecard-head">
              <SegmentedButton label="Example" options={content.samples.map((s) => ({ value: s.id, label: s.label }))} value={tab()} onChange={setTab} />
              <span class="codecard-file">{sample().file}</span>
            </div>
            <div class="codecard-body aa-scroll" style={{ "overflow-x": "auto" }} tabindex="0" aria-label={sample().file + " example"} innerHTML={sample().html} />
          </div>
        </div>
      </section>

      {/* ─ Features ─ */}
      <section id="features" class="section alt">
        <div class="wrap">
          <div class="section-head">
            <h2 class="h-section">What's in it so far</h2>
            <p class="lead">
              {content.changelog.entries.length || 25} milestones in. If you've written Luau you basically already know the language,
              the rest is about getting it into your Rust app without a fight.
            </p>
          </div>
          <div class="grid">
            <For each={FEATURES}>{(f) => (
              <div class="card tile">
                <span class="tile-icon"><span class="aa-icon" aria-hidden="true">{f.icon}</span></span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            )}</For>
          </div>
        </div>
      </section>

      {/* ─ Performance ─ */}
      <Show when={bench}>{(b) => (
        <section id="performance" class="section">
          <div class="wrap">
            <div class="section-head">
              <h2 class="h-section">How fast is it</h2>
              <p class="lead">
                Same programs under Rhue, {b().luau} and {b().rhai}. Rhue's a few times faster than Rhai, which walks a syntax tree.
                Luau's interpreter is still ahead, it's had years of tuning. Working on it.
              </p>
              <p class="muted" style={{ margin: 0, "font-size": "12px" }}>Measured at {b().measured}. {b().note}</p>
              <div class="legend">
                <Pill><span class="dot" style={{ background: "var(--brand)" }} />Rhue</Pill>
                <Pill><span class="dot" style={{ background: "var(--accent)" }} />Luau</Pill>
                <Pill><span class="dot" style={{ background: "var(--gold)" }} />Rhai</Pill>
              </div>
            </div>
            <div class="table-scroll aa-scroll" style={{ "overflow-x": "auto" }} tabindex="0" aria-label="Benchmark results">
              <Table
                rowKey={(r) => r.name}
                rows={b().rows}
                columns={[
                  { key: "name", label: "Script", render: (r) => <span class="mono" style={{ color: "var(--text-strong)" }}>{r.name}</span> },
                  { key: "stresses", label: "Stresses", render: (r) => <span class="muted">{r.stresses}</span> },
                  { key: "rhue", label: "Rhue ms", numeric: true, render: (r) => <span class="bench-rhue">{ms(r.rhue)}</span> },
                  { key: "luau", label: "Luau ms", numeric: true, render: (r) => <>{ms(r.luau)}<span class="bench-ratio">{ratio(r.rhue, r.luau)}</span></> },
                  { key: "rhai", label: "Rhai ms", numeric: true, render: (r) => <>{ms(r.rhai)}<span class="bench-ratio">{ratio(r.rhue, r.rhai)}</span></> },
                ]}
              />
            </div>
          </div>
        </section>
      )}</Show>

      {/* ─ Recent Changes ─ */}
      <Show when={recent.length}>
        <section id="changes" class="section alt">
          <div class="wrap">
            <div class="section-head" style={{ "flex-direction": "row", "align-items": "flex-end", "justify-content": "space-between", "flex-wrap": "wrap", gap: "12px" }}>
              <h2 class="h-section">Lately</h2>
              <LinkButton href="/changelog" variant="ghost" icon="history">Full changelog</LinkButton>
            </div>
            <div class="grid grid-wide">
              <For each={recent}>{(e) => (
                <A href={`/changelog/${e.slug}`} class="card tile">
                  <span class="tile-tag">{e.tag}<Show when={e.date}><span class="muted"> · {e.date}</span></Show></span>
                  <h3>{e.title}</h3>
                  <p>{e.summary}</p>
                </A>
              )}</For>
            </div>
          </div>
        </section>
      </Show>

      {/* ─ Tooling ─ */}
      <section id="tooling" class="section">
        <div class="wrap">
          <div class="section-head">
            <h2 class="h-section">Tooling and editors</h2>
            <p class="lead">
              The language server and debugger talk plain LSP and DAP over stdio, so any editor with a client works.
              There's Neovim config in the <a href={`${REPO_URL}#%EF%B8%8F-editor-support`} rel="noopener">README</a>.
            </p>
          </div>
          <div class="card rows" style={{ overflow: "hidden" }}>
            <For each={TOOLS}>{(t) => (
              <div class="tool-row">
                <span class="tool-name"><span class="aa-icon" aria-hidden="true">{t.icon}</span>{t.name}</span>
                <span class="tool-what">{t.what}</span>
                <code class="tool-cmd aa-scroll">{t.cmd}</code>
              </div>
            )}</For>
          </div>
        </div>
      </section>

      {/* ─ What's Next ─ */}
      <section id="roadmap" class="section alt">
        <div class="wrap">
          <h2 class="h-section">What's next</h2>
          <Show when={content.next.length} fallback={<p class="lead">Nothing planned on paper right now. Check the changelog for what just landed.</p>}>
            <div class="grid grid-wide">
              <For each={content.next}>{(n) => (
                <div class="card tile">
                  <Show when={n.tag}><span class="tile-tag">{n.tag}</span></Show>
                  <h3>{n.title}</h3>
                  <p innerHTML={n.body} />
                </div>
              )}</For>
            </div>
          </Show>
        </div>
      </section>

      <SectionNav sections={SECTIONS.filter((s) => s.id !== "changes" || recent.length).filter((s) => s.id !== "performance" || bench)} />
    </>
  );
}
