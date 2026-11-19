import { createMemo, For, Show } from "solid-js";
import { A, useParams } from "@solidjs/router";
import changelog from "virtual:rhue-content/changelog";
import { Pill, ScrollArea } from "../aalto";
import { LinkButton } from "../components/Layout";
import { Prose } from "../components/Prose";
import { useTitle } from "../lib/site";

export default function Changelog() {
  const params = useParams<{ slug?: string }>();
  const entries = changelog.entries;
  const index = createMemo(() => (params.slug ? entries.findIndex((e) => e.slug === params.slug) : 0));
  const entry = () => entries[index()];
  useTitle(() => (entry() && params.slug ? `${entry()!.tag}: ${entry()!.title}` : "Changelog"));

  return (
    <div class="wrap">
      <div class="page-head">
        <h1 class="h-page">Changelog</h1>
        <Show
          when={changelog.intro}
          fallback={<p class="lead">What changed in each release, straight out of the rhue repo's <code class="ic">changelog/</code> folder.</p>}
        >
          <Prose html={changelog.intro} class="lead" />
        </Show>
      </div>

      <Show
        when={entries.length}
        fallback={
          <div class="card empty" style={{ margin: "24px 0 96px" }}>
            <span class="tile-icon"><span class="aa-icon" aria-hidden="true">history</span></span>
            <h2 style={{ margin: 0, "font-size": "16px" }}>No changelogs yet</h2>
            <p class="muted" style={{ margin: 0 }}>Once the rhue repo has a changelog/ folder (or a CHANGELOG.md), it shows up here.</p>
          </div>
        }
      >
        <div class="split">
          <ScrollArea label="Releases" class="card split-side" subtle>
            <For each={entries}>{(e, i) => (
              <A href={`/changelog/${e.slug}`} class="entry-link" classList={{ active: i() === index() }} aria-current={i() === index() ? "page" : undefined}>
                <span class="entry-meta"><span class="entry-tag">{e.tag}</span><Show when={e.version}><span>v{e.version}</span></Show></span>
                <span class="entry-title">{e.title}</span>
              </A>
            )}</For>
          </ScrollArea>

          <article class="split-main">
            <Show
              when={entry()}
              fallback={
                <div class="card empty">
                  <span class="tile-icon"><span class="aa-icon" aria-hidden="true">search_off</span></span>
                  <h2 style={{ margin: 0, "font-size": "16px" }}>No release called "{params.slug}"</h2>
                  <LinkButton href="/changelog">Back to the latest</LinkButton>
                </div>
              }
            >
              {(e) => (
                <>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                      <Pill variant="brand">{e().tag}</Pill>
                      <Show when={e().version}><Pill>v{e().version}</Pill></Show>
                      <Show when={e().date}><Pill variant="dashed">{e().date}</Pill></Show>
                    </div>
                    <h2 class="h-page" style={{ "font-size": "24px", "line-height": "30px" }}>{e().title}</h2>
                  </div>
                  <Prose html={e().html} />
                  <nav class="pager" aria-label="Other releases">
                    <Show when={entries[index() + 1]} fallback={<span />}>
                      {(older) => <LinkButton href={`/changelog/${older().slug}`} variant="ghost" icon="arrow_back">{older().tag}: {older().title}</LinkButton>}
                    </Show>
                    <Show when={index() > 0 && entries[index() - 1]}>
                      {(newer) => <LinkButton href={`/changelog/${newer().slug}`} variant="ghost">{newer().tag}: {newer().title}<span class="aa-icon" aria-hidden="true">arrow_forward</span></LinkButton>}
                    </Show>
                  </nav>
                </>
              )}
            </Show>
          </article>
        </div>
      </Show>
    </div>
  );
}
