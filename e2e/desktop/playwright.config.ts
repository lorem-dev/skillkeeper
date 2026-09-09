import { defineConfig, devices } from '@playwright/test';

// The suite drives the PRODUCTION bundle, not the dev server: `vite preview`
// serves what `vite build` wrote to dist-tauri. That removes module
// transformation, the hot-module transport, and the dev/prod split from the
// failure surface, and makes every run prove the bundle boots. The webServer
// command below chains the build in: `vite preview` serves a stale
// `dist-tauri` without complaint (only a MISSING one exits loudly), so
// building every time a fresh server actually launches is what stops a
// developer from testing yesterday's bundle and believing today's passed.
// `reuseExistingServer: !process.env.CI` still means a server already
// listening on :4173 from an earlier run is reused with no rebuild at all --
// stop it between real changes to the renderer if you rely on this config
// picking them up locally.
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
    // `retries: 0` above means a trace on-first-retry never gets a retry to
    // fire on -- the two settings would otherwise cancel out and every
    // failure would ship with no trace at all.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm --filter @skillkeeper/desktop run frontend:build && ' +
      'pnpm --filter @skillkeeper/desktop exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
