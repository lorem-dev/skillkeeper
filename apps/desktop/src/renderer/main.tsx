/**
 * Renderer entry point.
 *
 * Creates the React root and mounts the application. This is a thin bootstrap;
 * all state and logic lives under the layered renderer tree (`@/app`, `@/pages`,
 * ...).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { App } from '@/app/App';
import { SshUnlockApp } from '@/app/SshUnlockApp';
import { hostPlatform } from '@/app/hostPlatform';
import { dismissPreloader } from '@/app/preloader';
import { bridgeClient } from '@/services/bridge';
import { setMacChrome, supportsBackdropBlur } from '@/shared/lib';
import '@/styles/index.scss';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in the DOM.');
}

// One bundle serves both windows: the ssh-unlock window renders its own tiny
// root (see SshUnlockApp.tsx), with no store, no shell and no startup load.
const isUnlockWindow = getCurrentWindow().label === 'ssh-unlock';

// Resolve host-derived values that the app reads synchronously (the platform
// string, used to pick the window chrome) before the first render. The startup
// preloader in index.html stays up during this single round-trip.
void bridgeClient.init().finally(() => {
  if (isUnlockWindow) {
    // Tiny, short-lived window: skip the platform/chrome setup and the
    // animated preloader fade that belong to the main window -- just get the
    // hardcoded startup overlay out of the way (it would otherwise sit on top
    // of the whole prompt, at the preloader's max z-index) and mount.
    dismissPreloader(false);
    createRoot(container).render(
      <StrictMode>
        <SshUnlockApp />
      </StrictMode>,
    );
    return;
  }

  // Now that init() has resolved the platform, record the chrome variant before
  // the first render so `dragRegion()` returns the drag tag on macOS. (Doing
  // this at App.tsx module-eval time ran before init and left drag disabled.)
  const platform = hostPlatform(bridgeClient.platform);
  setMacChrome(platform === 'mac');
  // Mark the platform on the document element (like data-theme) so styles can
  // key off it even for portaled surfaces (menus, dropdowns) that mount to
  // document.body, outside the `.sk-app` platform class.
  document.documentElement.setAttribute('data-platform', platform);
  // Flag machines whose engine parses backdrop-filter but does not paint it
  // (Chromium/WebView2 under software compositing -- blocklisted/disabled GPU,
  // Remote Desktop, VMs). The `@supports not` CSS fallbacks cannot catch this
  // (the property still reports as supported), so styles key off this attribute
  // instead. Set on documentElement so portaled surfaces (menus, modals) that
  // mount to document.body reach it too, like data-platform above.
  if (!supportsBackdropBlur()) {
    document.documentElement.setAttribute('data-backdrop', 'unsupported');
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
