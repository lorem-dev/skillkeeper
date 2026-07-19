/**
 * Renderer entry point.
 *
 * Creates the React root and mounts the application. This is a thin bootstrap;
 * all state and logic lives under the layered renderer tree (`@/app`, `@/pages`,
 * ...).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { hostPlatform } from '@/app/hostPlatform';
import { bridgeClient } from '@/services/bridge';
import { setMacChrome } from '@/shared/lib';
import '@/styles/index.scss';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in the DOM.');
}

// Resolve host-derived values that the app reads synchronously (the platform
// string, used to pick the window chrome) before the first render. The startup
// preloader in index.html stays up during this single round-trip.
void bridgeClient.init().finally(() => {
  // Now that init() has resolved the platform, record the chrome variant before
  // the first render so `dragRegion()` returns the drag tag on macOS. (Doing
  // this at App.tsx module-eval time ran before init and left drag disabled.)
  setMacChrome(hostPlatform(bridgeClient.platform) === 'mac');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
