import { createEffect, on, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { glideToId, theme } from "../lib/site";

/**
 * Markdown the content plugin already rendered at build time. It's our own repo's
 * markdown going through marked, not user input, so innerHTML is fine here.
 * Clicks on links get routed: #anchors glide, /paths go through the router.
 * ```mermaid blocks get drawn here, the rest is plain html.
 */
export function Prose(props: { html: string; class?: string }) {
  const navigate = useNavigate();
  let el!: HTMLDivElement;

  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!a || !href || a.target) return;
    if (href.startsWith("#")) {
      if (glideToId(decodeURIComponent(href.slice(1)))) e.preventDefault();
    } else if (href.startsWith("/")) {
      e.preventDefault();
      navigate(href);
    }
  };

  // redraw when the html or the theme changes, the colours are baked into the svg
  onMount(() => {
    createEffect(on([() => props.html, theme], () => drawCharts(el)));
  });

  return <div ref={el} class={"prose " + (props.class ?? "")} innerHTML={props.html} onClick={onClick} />;
}

// ─ Mermaid ───────────────────────────────────────────────────────────────────

let charts = 0;

async function drawCharts(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(".md-mermaid");
  if (!blocks.length) return; // most pages never load mermaid at all

  const { default: mermaid } = await import("mermaid");
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();

  // the base theme, coloured from the aalto tokens so charts match the page
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // natural size and scroll sideways, instead of shrinking wide charts until the text is tiny
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    state: { useMaxWidth: false },
    class: { useMaxWidth: false },
    er: { useMaxWidth: false },
    fontFamily: v("--font-sans"),
    themeVariables: {
      darkMode: document.documentElement.dataset.theme === "dark",
      fontFamily: v("--font-sans"),
      fontSize: "14px",
      background: v("--base"),
      primaryColor: v("--recessed"),
      primaryTextColor: v("--text-strong"),
      primaryBorderColor: v("--line-strong"),
      secondaryColor: v("--brand-tint"),
      secondaryTextColor: v("--text-strong"),
      secondaryBorderColor: v("--text-brand"),
      tertiaryColor: v("--accent-tint"),
      tertiaryTextColor: v("--text-strong"),
      tertiaryBorderColor: v("--accent"),
      lineColor: v("--text-subtle"),
      textColor: v("--text-default"),
      mainBkg: v("--recessed"),
      nodeBorder: v("--line-strong"),
      clusterBkg: v("--elevated"),
      clusterBorder: v("--line"),
      edgeLabelBackground: v("--base"),
      noteBkgColor: v("--gold-tint"),
      noteTextColor: v("--text-default"),
      noteBorderColor: v("--gold"),
    },
  });

  for (const block of blocks) {
    const src = block.dataset.src ?? "";
    try {
      const { svg } = await mermaid.render(`mermaid-${++charts}`, src);
      block.innerHTML = svg;
    } catch (e) {
      // a broken chart shows its source and the error instead of nothing
      block.innerHTML = "";
      const pre = document.createElement("pre");
      pre.textContent = src;
      const err = document.createElement("p");
      err.className = "md-mermaid-error";
      err.textContent = "This chart didn't parse: " + (e as Error).message;
      block.append(err, pre);
    }
  }
}
