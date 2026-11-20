import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { rhueContent } from "./scripts/content";

// same as public/_headers, so the debugger works under vite too
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [solid(), rhueContent()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    target: "es2022",
    // mermaid's and monaco's chunks are huge but only load on the pages using them
    chunkSizeWarningLimit: 4096,
  },
});
