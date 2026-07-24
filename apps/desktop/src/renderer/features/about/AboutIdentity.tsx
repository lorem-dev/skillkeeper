/**
 * About identity: the SkillKeeper logo, name, version, and (optionally) the
 * tagline. Presentational fragment shared by the About dialog (with tagline)
 * and the onboarding welcome screen (without). Renders a fragment so it drops
 * straight into either layout's flow.
 */
import { useTranslator } from '@/systems/i18n';
import logoLight from '../../../../../../assets/icons/icon-default.png';
import logoDark from '../../../../../../assets/icons/icon-dark.png';
import { useAboutInfo } from './useAboutInfo';
import './AboutDialog.scss';

export interface AboutIdentityProps {
  /** Show the tagline line under the version. Defaults to true (dialog). */
  readonly showTagline?: boolean;
}

export function AboutIdentity({ showTagline = true }: AboutIdentityProps) {
  const t = useTranslator();
  const { version, dark } = useAboutInfo();
  return (
    <>
      <img
        className="sk-about__logo"
        src={dark ? logoDark : logoLight}
        alt=""
        width={72}
        height={72}
      />
      <div className="sk-about__name">{t('app.title')}</div>
      {version !== '' && <div className="sk-about__version">{t('about.version', { version })}</div>}
      {showTagline && <div className="sk-about__tagline">{t('about.tagline')}</div>}
    </>
  );
}
