import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

// Mirror the renderer aliases from vite.config.ts so Storybook's Vite resolves
// the same paths the app does.
const alias = {
  '@': fromHere('../src/renderer'),
  '@skillkeeper/i18n/lazy': fromHere('../../../packages/i18n/src/lazy.ts'),
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
