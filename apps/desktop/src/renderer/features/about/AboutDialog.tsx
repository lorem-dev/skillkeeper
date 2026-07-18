/**
 * About dialog: the SkillKeeper logo, name, version, tagline, and copyright.
 * Opened from the application menu's About item (bridgeClient.onMenuAbout,
 * subscribed in App.tsx) via the store's aboutOpen/openAbout/closeAbout,
 * mirroring the logs/terminal/tasks overlay pattern.
 */
import { useEffect, useState } from 'react';
import { Modal } from '@/shared/ui';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import logoLight from '../../../../build/icon-default.png';
import logoDark from '../../../../build/icon-dark.png';
import './AboutDialog.scss';

export function AboutDialog() {
  const open = useSkillkeeperStore((s) => s.aboutOpen);
  const closeAbout = useSkillkeeperStore((s) => s.closeAbout);
  const theme = useSkillkeeperStore((s) => s.config?.general.theme ?? 'system');
  const t = useTranslator();
  const [version, setVersion] = useState('');

  // Fetch the app version each time the dialog opens (cheap, and keeps this
  // component free of any lifecycle assumption about when the bridge is ready).
  useEffect(() => {
    if (!open) return;
    let active = true;
    void bridgeClient.getAppVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Copyright years: a single "2026" while the end year is still 2026, otherwise
  // the range "2026-<end>". The end year is the build year for a production build
  // (baked via __SK_BUILD_YEAR__ at build time), or the current year in dev.
  const endYear = import.meta.env.PROD ? __SK_BUILD_YEAR__ : new Date().getFullYear();
  const years = endYear > 2026 ? `2026-${endYear}` : '2026';

  return (
    <Modal open={open} onClose={closeAbout} className="sk-about">
      <div className="sk-about__body">
        <img
          className="sk-about__logo"
          src={dark ? logoDark : logoLight}
          alt=""
          width={72}
          height={72}
        />
        <div className="sk-about__name">{t('app.title')}</div>
        {version !== '' && <div className="sk-about__version">{t('about.version', { version })}</div>}
        <div className="sk-about__tagline">{t('about.tagline')}</div>
        <div className="sk-about__copyright">{t('about.copyright', { years })}</div>
      </div>
    </Modal>
  );
}
