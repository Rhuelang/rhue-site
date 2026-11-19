import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import design from "virtual:rhue-content/design";
import { Pill, TextField } from "../aalto";
import { REPO_URL } from "../components/Layout";
import { Prose } from "../components/Prose";
import { SectionNav } from "../components/SectionNav";
import { glideToId, useTitle } from "../lib/site";

export default function Design() {
  const d = design;
  useTitle(() => "Design notes");
  const [query, setQuery] = createSignal("");
  const [shown, setShown] = createSignal(d.decisions);
  let body!: HTMLDivElement;

  // filter the key decisions in place, they're plain html from the build
  createEffect(() => {
    const q = query().trim().toLowerCase();
    let n = 0;
    body.querySelectorAll<HTMLElement>(".md-def").forEach((li) => {
      const hit = !q || li.textContent!.toLowerCase().includes(q);
      li.hidden = !hit;
      if (hit) n++;
    });
    setShown(n);
  });

  onMount(() => { if (location.hash) requestAnimationFrame(() => glideToId(decodeURIComponent(location.hash.slice(1)))); });

  return (
    <div class="wrap wrap-narrow">
      <div class="page-head">
        <Pill variant="dashed">docs/DESIGN.md</Pill>
        <h1 class="h-page">{d.title}</h1>
        <Show when={d.intro}><p class="lead" innerHTML={d.intro} /></Show>
        <div class="toc">
          <span class="muted" style={{ "font-size": "12px", "font-weight": 500 }}>On this page</span>
          <For each={d.toc}>{(t) => (
            <a class="aa-sl aa-btn aa-btn-outline aa-btn-s" href={"#" + t.id} onClick={(e) => { if (glideToId(t.id)) e.preventDefault(); }}>{t.text}</a>
          )}</For>
          <a class="aa-sl aa-btn aa-btn-ghost aa-btn-s" href={`${REPO_URL}/blob/main/docs/DESIGN.md`} rel="noopener">
            <span class="aa-icon" aria-hidden="true">open_in_new</span>Source
          </a>
        </div>
        <Show when={d.decisions > 0}>
          <div style={{ width: "100%", display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap" }}>
            <TextField
              label="Filter key decisions"
              placeholder="coroutines, GC, M19…"
              leadingIcon="search"
              value={query()}
              onChange={setQuery}
              style={{ flex: "1 1 280px" }}
            />
            <span class="muted" style={{ "font-size": "13px" }}>{shown()} of {d.decisions}</span>
          </div>
        </Show>
      </div>
      <div class="doc-body" ref={body}>
        <Prose html={d.html} />
      </div>
      <SectionNav sections={d.toc.map((t) => ({ id: t.id, label: t.text }))} />
    </div>
  );
}
