import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite build for the Tauri frontend: it builds the React renderer under
// `src/renderer`, output to `dist-tauri` where `tauri.conf.json`
// `frontendDist` points.
const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

// Workspace packages are aliased to their TypeScript source so the desktop app
// builds without requiring the libraries to be compiled first. The renderer
// additionally gets `@/` -> src/renderer.
const alias = {
  "@skillkeeper/i18n/lazy": fromHere("../../packages/i18n/src/lazy.ts"),
  "@skillkeeper/i18n": fromHere("../../packages/i18n/src/index.ts"),
  "@": fromHere("./src/renderer"),
};

export default defineConfig({
  root: "src/renderer",
  // Bake the build year so a production build shows it in the About-dialog
  // copyright range.
  define: { __SK_BUILD_YEAR__: JSON.stringify(new Date().getFullYear()) },
  resolve: { alias },
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../../dist-tauri",
    emptyOutDir: true,
    // Never ship sourcemaps in the packaged app: they would leak original
    // source into the bundle. Vite already defaults this off; keep it explicit
    // so no preset or dependency can flip it on for a production build.
    sourcemap: false,
    rollupOptions: {
      input: fromHere("./src/renderer/index.html"),
      output: {
        // Split large, stable vendor deps into their own cacheable chunks;
        // everything else keeps Rollup's own dynamic-import splitting for pages
        // and locale catalogs.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/node_modules/react-dom/") || id.includes("/node_modules/react/")) {
            return "vendor-react";
          }
          if (
            id.includes("/node_modules/motion/") ||
            id.includes("/node_modules/motion-dom/") ||
            id.includes("/node_modules/motion-utils/") ||
            id.includes("/node_modules/framer-motion/")
          ) {
            return "vendor-motion";
          }
          if (id.includes("/node_modules/@xterm/")) return "vendor-xterm";
          return "vendor";
        },
      },
    },
  },
});
