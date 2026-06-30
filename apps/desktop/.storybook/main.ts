import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

// Mirror the renderer aliases from electron.vite.config.ts so Storybook's Vite
// resolves the same paths the app does. Do NOT import electron.vite.config.ts:
// it carries Electron-only main/preload config Storybook must not run.
const alias = {
  '@': fromHere('../src/renderer'),
  '@skillkeeper/core': fromHere('../../../packages/core/src/index.ts'),
  '@skillkeeper/config': fromHere('../../../packages/config/src/index.ts'),
  '@skillkeeper/agents': fromHere('../../../packages/agents/src/index.ts'),
  '@skillkeeper/i18n': fromHere('../../../packages/i18n/src/index.ts'),
};

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/renderer/**/*.stories.@(ts|tsx)'],
  addons: [],
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, { resolve: { alias } }),
};

export default config;
