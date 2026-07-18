import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import sonda from 'sonda/vite';

const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

// Minify the (small, hand-authored) inline preloader CSS: drop comments,
// collapse whitespace, and trim around braces/semicolons/commas. Colons are
// left untouched so `@media (feature: value)` and `property: value` stay valid.
function minifyInlineCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

// This Vite build minifies JS/CSS assets but leaves the index.html entry (and
// its inline preloader <style>) untouched. Minify it at build time: minify the
// inline CSS, then strip comments and collapse whitespace in the markup (safe
// here -- the document has no whitespace-sensitive text nodes).
function minifyIndexHtml(): Plugin {
  return {
    name: 'sk-minify-index-html',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<style>([\s\S]*?)<\/style>/g, (_all, css: string) => `<style>${minifyInlineCss(css)}</style>`)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim();
    },
  };
}

// Workspace packages are aliased to their TypeScript source so the desktop
// app builds without requiring the libraries to be compiled first.
const alias = {
  '@skillkeeper/core': fromHere('../../packages/core/src/index.ts'),
  '@skillkeeper/config': fromHere('../../packages/config/src/index.ts'),
  '@skillkeeper/agents': fromHere('../../packages/agents/src/index.ts'),
  '@skillkeeper/i18n/lazy': fromHere('../../packages/i18n/src/lazy.ts'),
  '@skillkeeper/i18n': fromHere('../../packages/i18n/src/index.ts'),
};

// `electron-vite build --mode analyze` turns on the Sonda bundle report for the
// renderer (the only bundle whose size matters). A normal build/dev leaves it
// off, so it adds no overhead to the default workflow.
export default defineConfig(({ mode }) => {
  const analyze = mode === 'analyze';

  return {
    main: {
      resolve: { alias },
      // `electron` is a devDependency, so externalizeDepsPlugin does not cover
      // it; externalize it explicitly so the runtime API is used, not the npm
      // shim.
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'out/main',
        rollupOptions: { external: ['electron', 'node-pty'] },
      },
    },
    preload: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: 'out/preload',
        // A sandboxed preload (sandbox: true) must be CommonJS; ESM preloads do
        // not load in the sandbox. Emit a .cjs file and reference it from main.
        // `electron` must stay external or the npm path-shim gets bundled and
        // contextBridge becomes undefined.
        rollupOptions: {
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: 'index.cjs',
          },
        },
      },
    },
    renderer: {
      root: 'src/renderer',
      // Bake the build year so a production build shows it in the About-dialog
      // copyright range; dev uses the runtime year (see AboutDialog). The config
      // is evaluated at build time, so `new Date()` here is the build date.
      define: { __SK_BUILD_YEAR__: JSON.stringify(new Date().getFullYear()) },
      // The renderer also gets the `@/` alias -> src/renderer, the entry point
      // for the FSD-inspired layered imports (`@/shared`, `@/app/store`, ...).
      resolve: { alias: { ...alias, '@': fromHere('./src/renderer') } },
      plugins: [
        react(),
        minifyIndexHtml(),
        sonda({
          enabled: analyze,
          format: 'html',
          open: false,
          gzip: true,
          brotli: true,
          sources: true,
          filename: 'renderer-bundle.html',
          outputDir: fromHere('./out/analyze'),
        }),
      ],
      build: {
        outDir: 'out/renderer',
        // Minify the production renderer (JS, CSS, and the index.html entry with
        // its inline preloader styles). electron-vite leaves the renderer on
        // Vite's own defaults, and this Vite build does not minify unless asked.
        // Disabled under `analyze` so Sonda can attribute bytes to readable
        // source via the sourcemaps it needs.
        minify: !analyze,
        sourcemap: analyze,
        rollupOptions: {
          input: fromHere('./src/renderer/index.html'),
          output: {
            // Split large, stable vendor deps into their own cacheable chunks.
            // Return undefined for everything else so Rollup keeps its own
            // dynamic-import splitting for pages and locale catalogs. xterm is
            // statically imported (the terminal mounts at startup) -- this is a
            // caching split, not a defer.
            manualChunks(id) {
              if (!id.includes('node_modules')) return undefined;
              if (id.includes('/node_modules/react-dom/') || id.includes('/node_modules/react/')) {
                return 'vendor-react';
              }
              if (
                id.includes('/node_modules/motion/') ||
                id.includes('/node_modules/motion-dom/') ||
                id.includes('/node_modules/motion-utils/') ||
                id.includes('/node_modules/framer-motion/')
              ) {
                return 'vendor-motion';
              }
              if (id.includes('/node_modules/@xterm/')) return 'vendor-xterm';
              return 'vendor';
            },
          },
        },
      },
    },
  };
});
