/**
 * About footer: the docs / repository / license link badges and the copyright
 * line. Presentational fragment shared by the About dialog and the onboarding
 * welcome screen (where it is pinned to the bottom of the layer).
 */
import { Badge, Tooltip } from '@/shared/ui';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import { useAboutInfo } from './useAboutInfo';
import './AboutDialog.scss';

const REPO_URL = 'https://github.com/lorem-dev/skillkeeper';
const LICENSE_URL = 'https://github.com/lorem-dev/skillkeeper/tree/main?tab=Apache-2.0-1-ov-file';

export function AboutFooter() {
  const t = useTranslator();
  const { years, docsUrl } = useAboutInfo();
  return (
    <>
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
    </>
  );
}
