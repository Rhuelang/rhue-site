import { useNavigate } from "@solidjs/router";
import { glideToId } from "../lib/site";

/**
 * Markdown the content plugin already rendered at build time. It's our own repo's
 * markdown going through marked, not user input, so innerHTML is fine here.
 * Clicks on links get routed: #anchors glide, /paths go through the router.
 */
export function Prose(props: { html: string; class?: string }) {
  const navigate = useNavigate();
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
  return <div class={"prose " + (props.class ?? "")} innerHTML={props.html} onClick={onClick} />;
}
