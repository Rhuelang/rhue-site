import { type JSX, Show } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import content from "virtual:rhue-content";
import { Button, IconButton } from "../aalto";
import { theme, toggleTheme } from "../lib/site";

export const REPO_URL = `https://github.com/${content.meta.repo}`;

export function SiteHeader() {
  return (
    <header class="site-header">
      <div class="wrap">
        <A href="/" class="brand" end>
          <img src="/brand/logo.svg" alt="" width="30" height="30" />
          Rhue
        </A>
        <nav class="site-nav" aria-label="Site">
          <A href="/" end activeClass="active">Home</A>
          <A href="/design" activeClass="active">Design notes</A>
          <A href="/changelog" activeClass="active">Changelog</A>
          <A href="/playground" activeClass="active">Playground</A>
        </nav>
        <div class="header-actions">
          <IconButton
            icon={theme() === "dark" ? "light_mode" : "dark_mode"}
            label={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleTheme}
          />
          <a class="aa-btn aa-btn-outline aa-btn-s aa-sl" href={REPO_URL} rel="noopener">
            <span class="aa-icon" aria-hidden="true">code</span>GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const m = content.meta;
  return (
    <footer class="site-footer">
      <div class="wrap">
        <span>
          Rhue v{m.version} is MIT or Apache-2.0, your pick.
          <Show when={m.commit}>
            {" "}Built from <a class="mono" href={`${REPO_URL}/commit/${m.commit}`} rel="noopener">{m.commit!.slice(0, 7)}</a>.
          </Show>
        </span>
        <nav aria-label="Project links">
          <A href="/playground">Playground</A>
          <A href="/design">Design notes</A>
          <A href="/changelog">Changelog</A>
          <a href={REPO_URL} rel="noopener">GitHub</a>
          <a href="https://github.com/rhuelang/rhue-site" rel="noopener">Site source</a>
        </nav>
      </div>
    </footer>
  );
}

export function Layout(props: { children?: JSX.Element }) {
  // the playground fills the window, a footer under it would just be in the way
  const app = () => useLocation().pathname.startsWith("/playground");
  return (
    <>
      <SiteHeader />
      <main id="top" classList={{ "is-app": app() }}>{props.children}</main>
      <Show when={!app()}><SiteFooter /></Show>
    </>
  );
}

/** A button that navigates. Aalto's Button is a <button>, links want an <a>. */
export function LinkButton(props: { href: string; variant?: "primary" | "secondary" | "ghost" | "outline"; size?: "s" | "m" | "l"; icon?: string; external?: boolean; onClick?: (e: MouseEvent) => void; children: JSX.Element }) {
  const cls = () => `aa-sl aa-btn aa-btn-${props.variant ?? "secondary"} aa-btn-${props.size ?? "m"}`;
  const inner = () => (
    <>
      <Show when={props.icon}><span class="aa-icon" aria-hidden="true">{props.icon}</span></Show>
      {props.children}
    </>
  );
  return (
    <Show when={!props.external && props.href.startsWith("/")} fallback={<a class={cls()} href={props.href} rel="noopener" onClick={props.onClick}>{inner()}</a>}>
      <A class={cls()} href={props.href} onClick={props.onClick}>{inner()}</A>
    </Show>
  );
}

export { Button };
