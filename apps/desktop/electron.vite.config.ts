import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import sonda from 'sonda/vite';

const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

// Workspace packages are aliased to their TypeScript source so the desktop
// app builds without requiring the libraries to be compiled first.
const alias = {
  '@skillkeeper/core': fromHere('../../packages/core/src/index.ts'),
  '@skillkeeper/config': fromHere('../../packages/config/src/index.ts'),
  '@skillkeeper/agents': fromHere('../../packages/agents/src/index.ts'),
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
      // The renderer also gets the `@/` alias -> src/renderer, the entry point
      // for the FSD-inspired layered imports (`@/shared`, `@/app/store`, ...).
      resolve: { alias: { ...alias, '@': fromHere('./src/renderer') } },
      plugins: [
        react(),
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
        // Sonda attributes bytes back to source through source maps, so emit
        // them when analyzing.
        sourcemap: analyze,
        rollupOptions: {
          input: fromHere('./src/renderer/index.html'),
        },
      },
    },
  };
});
