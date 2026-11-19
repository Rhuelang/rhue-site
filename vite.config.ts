import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { rhueContent } from "./scripts/content";

export default defineConfig({
  plugins: [solid(), rhueContent()],
  build: { outDir: "dist", target: "es2022" },
});
