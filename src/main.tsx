import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { lazy } from "solid-js";
import { Layout } from "./components/Layout";
import Home from "./pages/Home";
import "./aalto/tokens.css";
import "./aalto/bundle.css";
import "./styles/site.css";

// design notes are the heavy one, load pages when visited
const Design = lazy(() => import("./pages/Design"));
const NotFound = lazy(() => import("./pages/NotFound"));

render(
  () => (
    <Router root={Layout}>
      <Route path="/" component={Home} />
      <Route path="/design" component={Design} />
      <Route path="*404" component={NotFound} />
    </Router>
  ),
  document.getElementById("root")!,
);
