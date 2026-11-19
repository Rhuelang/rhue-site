import { For } from "solid-js";
import { IconButton } from "../aalto";
import { glide, glideToId, useScrollSpy } from "../lib/site";

export interface NavSection { id: string; label: string }

/** The floating bar at the bottom. Blurs in once the first section's on screen and tracks where you are. */
export function SectionNav(props: { sections: NavSection[] }) {
  const { active, past } = useScrollSpy(props.sections.map((s) => s.id));
  return (
    <div class="snav" classList={{ "is-hidden": !past() }} aria-hidden={!past()}>
      <nav aria-label="Jump to section" class="aa-scroll">
        <IconButton icon="arrow_upward" label="Back to top" onClick={() => glide(0)} />
        <span class="snav-sep" aria-hidden="true" />
        <For each={props.sections}>{(s) => (
          <a
            href={"#" + s.id}
            class="aa-sl aa-seg-btn"
            classList={{ "is-selected": active() === s.id }}
            aria-current={active() === s.id ? "location" : undefined}
            tabindex={past() ? 0 : -1}
            onClick={(e) => { if (glideToId(s.id)) e.preventDefault(); }}
          >
            {s.label}
          </a>
        )}</For>
      </nav>
    </div>
  );
}
