import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@skillkeeper/core/testing': fromRoot('./packages/core/src/testing/index.ts'),
      '@skillkeeper/core': fromRoot('./packages/core/src/index.ts'),
      '@skillkeeper/config': fromRoot('./packages/config/src/index.ts'),
      '@skillkeeper/agents': fromRoot('./packages/agents/src/index.ts'),
      '@skillkeeper/i18n': fromRoot('./packages/i18n/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // The 90% gate applies to the core logic packages. Front-end shells
      // (cli, desktop) are integration layers covered by their own targeted
      // tests; they are excluded from the coverage gate until their commands
      // and screens are fleshed out (see the design spec, testing strategy).
      include: [
        'packages/core/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/i18n/src/**/*.ts',
        'packages/agents/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/testing/**',
        '**/index.ts',
        '**/*.d.ts',
        '**/model.ts',
        '**/ports.ts',
        '**/adapter.ts',
        '**/node/**',
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
