import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { rhueContent } from "./scripts/content";

export default defineConfig({
  plugins: [solid(), rhueContent()],
  build: {
    outDir: "dist",
    target: "es2022",
    // mermaid's chunks are huge but only load on a page with a chart in it
    chunkSizeWarningLimit: 1600,
  },
});
