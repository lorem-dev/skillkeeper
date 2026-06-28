import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  main: {
    resolve: { alias },
    // `electron` is a devDependency, so externalizeDepsPlugin does not cover it;
    // externalize it explicitly so the runtime API is used, not the npm shim.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { external: ['electron'] },
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
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: fromHere('./src/renderer/index.html'),
      },
    },
  },
});
