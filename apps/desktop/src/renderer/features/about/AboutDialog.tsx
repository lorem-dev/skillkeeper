/**
 * About dialog: the SkillKeeper logo, name, version, tagline, and copyright.
 * Opened from the application menu's About item (bridgeClient.onMenuAbout,
 * subscribed in App.tsx) via the store's aboutOpen/openAbout/closeAbout,
 * mirroring the logs/terminal/tasks overlay pattern.
 */
import { useEffect, useState } from 'react';
import { Modal, Badge, Tooltip } from '@/shared/ui';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import logoLight from '../../../../../../assets/icons/icon-default.png';
import logoDark from '../../../../../../assets/icons/icon-dark.png';
import './AboutDialog.scss';

// The published docs live on GitHub Pages, versioned by mike. A release build
// links to its own version; a dev build has no published version, so it links
// to the `latest` alias.
const DOCS_BASE = 'https://lorem-dev.github.io/skillkeeper';
const REPO_URL = 'https://github.com/lorem-dev/skillkeeper';
const LICENSE_URL = 'https://github.com/lorem-dev/skillkeeper/tree/main?tab=Apache-2.0-1-ov-file';

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

  const docsVersion = import.meta.env.PROD && version !== '' ? version : 'latest';
  const docsUrl = `${DOCS_BASE}/${docsVersion}/`;

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
        <div className="sk-about__links">
          <Tooltip content={t('about.openDocs')}>
            <button
              type="button"
              className="sk-about__link"
              aria-label={t('about.openDocs')}
              onClick={() => void bridgeClient.openExternal(docsUrl)}
            >
              <Badge tone="accent">{t('about.docs')}</Badge>
            </button>
          </Tooltip>
          <Tooltip content={t('about.openRepo')}>
            <button
              type="button"
              className="sk-about__link"
              aria-label={t('about.openRepo')}
              onClick={() => void bridgeClient.openExternal(REPO_URL)}
            >
              <Badge tone="neutral">{t('about.repo')}</Badge>
            </button>
          </Tooltip>
          <Tooltip content={t('about.openLicense')}>
            <button
              type="button"
              className="sk-about__link"
              aria-label={t('about.openLicense')}
              onClick={() => void bridgeClient.openExternal(LICENSE_URL)}
            >
              <Badge tone="neutral">{t('about.license')}</Badge>
            </button>
          </Tooltip>
        </div>
        <div className="sk-about__copyright">{t('about.copyright', { years })}</div>
      </div>
    </Modal>
  );
}
