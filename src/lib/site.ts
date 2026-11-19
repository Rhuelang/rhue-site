import { createEffect, createSignal, onCleanup } from "solid-js";

// ─ Theme ─────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark";

// index.html already picked one before paint, start from that
const [theme, setThemeSignal] = createSignal<Theme>((document.documentElement.dataset.theme as Theme) ?? "dark");
export { theme };

export function setTheme(t: Theme) {
  setThemeSignal(t);
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("rhue-theme", t); } catch { /* private mode, whatever */ }
}

export const toggleTheme = () => setTheme(theme() === "dark" ? "light" : "dark");

// ─ Scrolling ─────────────────────────────────────────────────────────────────

let anim = 0;

/** Scroll the page to `to`. Further jumps get more time, but less per pixel, so long ones move faster. */
export function glide(to: number) {
  const sc = document.scrollingElement ?? document.documentElement;
  const from = sc.scrollTop;
  const target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, to));
  const dist = Math.abs(target - from);
  cancelAnimationFrame(anim);
  if (dist < 1) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { sc.scrollTop = target; return; }
  const duration = Math.min(900, 220 + Math.sqrt(dist) * 12);
  const start = performance.now();
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    sc.scrollTop = from + (target - from) * ease(t);
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/** Glide to an element by id, a little above it so headings don't touch the edge. */
export function glideToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return false;
  glide(el.getBoundingClientRect().top + window.scrollY - 24);
  history.replaceState(history.state, "", "#" + id);
  return true;
}

// ─ Page Title ────────────────────────────────────────────────────────────────

export function useTitle(title: () => string) {
  createEffect(() => {
    const t = title();
    document.title = t ? `${t} · Rhue` : "Rhue: Luau-style scripting for Rust";
  });
}

// ─ Scroll Spy ────────────────────────────────────────────────────────────────

/** Which of `ids` you're currently reading, and whether you've scrolled past the first one's top. */
export function useScrollSpy(ids: string[], showAt = 0.6) {
  const [active, setActive] = createSignal<string | null>(null);
  const [past, setPast] = createSignal(false);
  const measure = () => {
    const vh = window.innerHeight;
    let cur: string | null = null;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= vh * 0.4) cur = id;
    }
    // the last section's too short to reach the line, so hitting the bottom counts
    const last = document.getElementById(ids[ids.length - 1]);
    if (last && last.getBoundingClientRect().bottom <= vh + 2) cur = last.id;
    const first = document.getElementById(ids[0]);
    setPast(!!first && first.getBoundingClientRect().top < vh * showAt);
    setActive(cur);
  };
  window.addEventListener("scroll", measure, { passive: true });
  window.addEventListener("resize", measure);
  queueMicrotask(measure);
  onCleanup(() => {
    window.removeEventListener("scroll", measure);
    window.removeEventListener("resize", measure);
  });
  return { active, past };
}
