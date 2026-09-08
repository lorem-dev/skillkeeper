import { defineConfig, devices } from '@playwright/test';

// The suite drives the PRODUCTION bundle, not the dev server: `vite preview`
// serves what `vite build` wrote to dist-tauri. That removes module
// transformation, the hot-module transport, and the dev/prod split from the
// failure surface, and makes every run prove the bundle boots. Run
// `pnpm --filter @skillkeeper/desktop run frontend:build` at least once
// before this config's webServer has anything to serve.
export default defineConfig({
  testDir: './tests',
  // A retry turns a flake into a slow pass and throws away the signal. If a
  // spec is unstable, the spec or the harness is wrong.
  retries: 0,
  fullyParallel: true,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    // Layout-dependent visibility must not depend on the runner's default.
    viewport: { width: 1440, height: 900 },
    // The renderer animates with `motion`; a moving target is the classic
    // reason a click lands nowhere. Task 3 also zeroes durations in CSS.
    reducedMotion: 'reduce',
    locale: 'en-US',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @skillkeeper/desktop exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
