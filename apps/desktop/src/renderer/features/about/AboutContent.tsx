/**
 * About content: the SkillKeeper logo, name, version, tagline, docs/repo/
 * license links, and copyright. Presentational body used by the About dialog.
 * Composed from AboutIdentity (logo/name/version/tagline) and AboutFooter
 * (links/copyright); the onboarding welcome screen reuses those two pieces
 * directly so it can place the identity and the footer separately.
 */
import { AboutIdentity } from './AboutIdentity';
import { AboutFooter } from './AboutFooter';
import './AboutDialog.scss';

export function AboutContent() {
  return (
    <div className="sk-about__body">
      <AboutIdentity />
      <AboutFooter />
    </div>
  );
}
