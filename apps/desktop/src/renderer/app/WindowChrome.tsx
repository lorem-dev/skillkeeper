/**
 * App-level wiring for the frameless-window title bar.
 *
 * On macOS this renders nothing: the sidebar reserves and drags its own top
 * region (its `dragRegion` panel), and the toolbar/overlay headers are dragged
 * by their non-interactive parts (title + spacer), set up in App.scss
 * `.sk-app--mac`. On Windows/Linux it renders the (pure) TitleBar strip with
 * the app title and custom window controls, wired to the bridge and tracking
 * the maximized state. (macOS shows no app title anywhere -- the sidebar no
 * longer carries one on any platform.)
 */
import { useEffect, useState } from 'react';
import { TitleBar } from '@/shared/ui';
import { bridgeClient } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { hostPlatform } from './hostPlatform';

export function WindowChrome() {
  const t = useTranslator();
  const platform = hostPlatform(bridgeClient.platform);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // macOS renders no strip, so it needs no maximize tracking.
    if (platform === 'mac') return undefined;
    let alive = true;
    void bridgeClient.isWindowMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    const off = bridgeClient.onMaximizeChange(setMaximized);
    return () => {
      alive = false;
      off();
    };
  }, [platform]);

  // macOS draws no chrome element -- the sidebar's own drag panel and the
  // header title/spacer areas (App.scss) move the window.
  if (platform === 'mac') return null;

  return (
    <TitleBar
      platform={platform}
      title={t('app.title')}
      maximized={maximized}
      onMinimize={() => bridgeClient.minimizeWindow()}
      onToggleMaximize={() => bridgeClient.toggleMaximizeWindow()}
      onClose={() => bridgeClient.closeWindow()}
      controlLabels={{
        minimize: t('titlebar.minimize'),
        maximize: t('titlebar.maximize'),
        restore: t('titlebar.restore'),
        close: t('titlebar.close'),
      }}
    />
  );
}
