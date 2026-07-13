/**
 * App-level wiring for the frameless-window title bar.
 *
 * On macOS there is no title-bar strip: the app content reaches the top, the
 * native traffic lights float over the sidebar's top-left, and the draggable
 * region is set on the top of the sidebar and page header (App.scss), so this
 * renders nothing. On Windows/Linux it renders the (pure) TitleBar strip with
 * custom window controls, wired to the bridge and tracking the maximized state.
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

  // No custom bar on macOS -- the native traffic lights and the drag regions on
  // the real content (App.scss) do the job.
  if (platform === 'mac') return null;

  return (
    <TitleBar
      platform={platform}
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
