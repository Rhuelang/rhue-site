import { LinkButton } from "../components/Layout";
import { useTitle } from "../lib/site";

export default function NotFound() {
  useTitle(() => "Not found");
  return (
    <div class="wrap">
      <div class="empty">
        <span class="tile-icon"><span class="aa-icon" aria-hidden="true">explore_off</span></span>
        <h1 class="h-page" style={{ "font-size": "22px" }}>Nothing here</h1>
        <p class="muted" style={{ margin: 0 }}>That page doesn't exist, or it moved.</p>
        <LinkButton href="/" variant="primary" icon="home">Back home</LinkButton>
      </div>
    </div>
  );
}
