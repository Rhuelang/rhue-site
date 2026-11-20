<div align="center">
  <img src="https://raw.githubusercontent.com/rhuelang/rhue/main/assets/Logo.svg" width="180" alt="Rhue logo">
  <h1>rhue-site</h1>
  <p>The website for <a href="https://github.com/rhuelang/rhue"><b>Rhue</b></a>, live at <a href="https://rhue.dev"><b>rhue.dev</b></a>. Solid, TypeScript and Vite, built with bun and served off Cloudflare. The docs on it all come straight out of the rhue repo, so it's never out of date with the actual language.</p>
  <p>
    <a href="https://github.com/rhuelang/rhue-site/actions/workflows/deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/rhuelang/rhue-site/deploy.yml?branch=main&amp;style=for-the-badge&amp;label=deploy" alt="Deploy status"></a>
    <a href="https://rhue.dev"><img src="https://img.shields.io/badge/rhue.dev-live-e07b4f?style=for-the-badge" alt="rhue.dev"></a>
    <a href="https://www.solidjs.com"><img src="https://img.shields.io/badge/solid-1.9-e07b4f?style=for-the-badge&amp;logo=solid" alt="Solid 1.9"></a>
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-1.4-e07b4f?style=for-the-badge&amp;logo=bun" alt="Bun 1.4"></a>
    <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/cloudflare-workers-blue?style=for-the-badge&amp;logo=cloudflare" alt="Cloudflare Workers"></a>
  </p>
</div>

## ⚡️ Running it

```powershell
bun install
bun run wasm          # the playground's engine, once and whenever playground/ changes
bun run dev
```

That builds off whatever's in `content/` already, which is committed, so it works without anything else checked out. To pull fresh docs from rhue first:

```powershell
bun run sync          # reads ..\rhue, a checkout next to this one
bun run dev
```

`bun run wasm` needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at whatever version `playground/Cargo.lock` has (it tells you if they don't match):

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.106 --locked
```

`RHUE_DIR` points it at a checkout somewhere else, and `RHUE_REPO=rhuelang/rhue` reads GitHub instead (plus `GITHUB_TOKEN` while it's private). Editing anything in `content/` while `dev` is running reloads the page with it, handy for checking how a changelog entry looks before it goes into rhue.

## 📦 Where the content comes from

Pretty much everything on the site that isn't layout lives in the rhue repo:

- **Design notes** come from `docs/DESIGN.md`. Lists of `**Label.** text` turn into the entry cards with a filter, and ✅ lists turn into the milestone list.
- **Changelog** comes from `changelog/index.json` and one markdown file per entry. Until that folder exists it splits `CHANGELOG.md` on its milestone headings instead.
- **What's next** comes from `changelog/next.json`.
- **The benchmark table** comes from `bench/results.json`.
- **The logo, favicon and version** come from `assets/` and `Cargo.toml`.

All of it gets turned into HTML at build time (`scripts/content.ts`, marked plus shiki for the code), so the browser never sees markdown. If something's malformed the build fails and tells you which file and why.

The home page copy, the feature cards and the code samples (`src/samples/`) are the site's own.

## 🛝 Playground

`/playground` is a little VS Code for Rhue that runs entirely in the browser. `playground/` is a Rust crate that builds rhue and rhue-lsp to wasm, `src/playground/` is the page around it.

- **Editor** is Monaco, so it's the actual VS Code editor. Hover, completion, signature help, go to definition across modules, references, rename, quick fixes, inlay hints, semantic colouring, outline and formatting all come from rhue-lsp running in a worker.
- **Running** happens in another worker, a fresh one per run. Stop just kills it, so an infinite loop can't take the tab down with it.
- **Debugger** has breakpoints with conditions, hit counts and logpoints, stepping, variables you can expand, watches, the call stack and a console that evaluates in whatever frame you've got selected. Pausing actually blocks the worker on `Atomics.wait`, which needs a `SharedArrayBuffer`, which needs the page cross-origin isolated. That's what the COOP/COEP headers in `public/_headers` (and `vite.config.ts` for dev) are for.
- **Profiler** counts every line and roughly how long it sat there, then colours the hot ones in the editor.
- **host.js** is the engine side. Whatever it registers (`host.fn`, `host.async`, `host.value`) turns into real natives on the engine, types and all, and the Engine panel shows calls and time spent per native after a run. It also has the compiler and limit settings, and "Show as Rust" writes the same engine out as host code.
- **Bytecode** panel shows what the current file compiles to, flip constant folding and watch it change.

Everything's kept in localStorage, and the share button squashes the files into the url. A host.js that comes in through a link doesn't run until you say it can, it's JavaScript after all.

`playground/vendor/rhue-lsp` is rhue-lsp 2.2.0 with a fix so it builds for plain wasm. Delete it (and the `[patch.crates-io]`) once rhue ships that.

## 🚀 Deploying

`.github/workflows/deploy.yml` does it: checks out rhue, syncs, builds the playground's wasm, builds, and runs `wrangler deploy` on pushes to main. It also runs whenever rhue sends a `rhue-updated` dispatch, which rhue's own `site.yml` workflow does when its docs change. PRs here just build.

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the repo secrets, and `RHUE_READ_TOKEN` as long as rhue is private. By hand:

```powershell
bun run deploy
```

`wrangler.jsonc` is assets only, no worker script. Routes like `/changelog/m25` don't exist as files, so `not_found_handling` hands them to `index.html` and the router takes it from there.

## 🎨 Looks

It's built on the Aalto · Cloudflare design system (`src/aalto/`, the same copy status-page and webmail use). `src/styles/site.css` only arranges things, every colour, radius and font comes from the system's tokens. Light and dark both work, it follows the system setting until you flip the toggle.

Code highlighting uses shiki's CSS variables theme, mapped onto the same tokens, so code switches theme along with everything else.

## 🗂️ Layout

| Path | What's in it |
| --- | --- |
| `content/` | docs synced from rhue, committed so builds don't need it |
| `scripts/sync-content.ts` | copies them over from a checkout or GitHub |
| `scripts/content.ts` | the vite plugin that renders them into `virtual:rhue-content` |
| `src/pages/` | home, design notes, changelog, 404 |
| `src/components/` | header, footer, the floating section nav, markdown output |
| `src/samples/` | the code tabs on the home page |
| `src/playground/` | the playground page, its workers and the Monaco setup |
| `playground/` | the Rust side of the playground, built into `src/playground/wasm/` |
| `scripts/build-wasm.ts` | `bun run wasm` |
| `src/aalto/` | the design system |
