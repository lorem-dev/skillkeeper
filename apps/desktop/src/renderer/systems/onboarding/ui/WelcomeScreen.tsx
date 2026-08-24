import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { useAnimationsEnabled, useAnimationScale, SK_DURATION, SK_EASE } from '@/shared/lib';
import { Button, FormSection } from '@/shared/ui';
import { LanguageThemeFields } from '@/systems/settings';
import { useOnboardingActions } from '../model/useOnboarding';
import { OnboardingLoader } from './OnboardingLoader';
import './WelcomeScreen.scss';

export interface WelcomeScreenProps {
  /** The About identity (logo/name/version), injected by the caller to keep the
   *  systems -> features boundary clean. Shown at the top. */
  readonly aboutIdentity: ReactNode;
  /** The About footer (links + copyright), pinned to the bottom of the layer. */
  readonly aboutFooter: ReactNode;
  /** The Settings row for choosing the SSH key, injected by the caller for the
   *  same reason as the About blocks: this system never imports `features/`. */
  readonly sshKeyField: ReactNode;
}

/**
 * Onboarding step 1: an opaque full-screen layer. The identity block and a
 * compact, labelled list of the settings worth having before anything else
 * (language, theme, and the SSH key private repositories need) sit centered;
 * the About footer is pinned to the bottom. The controls write straight to
 * config, same as `pages/Settings/SettingsPage.tsx`, and a hint says so.
 */
export function WelcomeScreen({ aboutIdentity, aboutFooter, sshKeyField }: WelcomeScreenProps) {
  const t = useTranslator();
  const config = useSkillkeeperStore((s) => s.config);
  const { next, skip } = useOnboardingActions();
  const animate = useAnimationsEnabled();
  const scale = useAnimationScale();

  // While the initial data is still loading, show the preloader spinner; the
  // content below fades in once it is ready.
  if (config === null) return <OnboardingLoader />;

  return (
    <div className="sk-onboarding-welcome" role="dialog" aria-modal="true">
      <motion.div
        className="sk-onboarding-welcome__inner"
        initial={animate ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: SK_DURATION.medium * scale, ease: SK_EASE }}
      >
        <div className="sk-onboarding-welcome__block">
          {aboutIdentity}
          <FormSection className="sk-onboarding-welcome__form">
            <LanguageThemeFields languageClassName="sk-onboarding-welcome__language" />
            {sshKeyField}
          </FormSection>
          <p className="sk-onboarding-welcome__hint">{t('onboarding.settingsLater')}</p>
          <div className="sk-onboarding-welcome__actions">
            {/* Ends the tour by jumping to its last step, so the closing screen
              still shows rather than the app appearing without explanation. */}
            <Button variant="secondary" glass onClick={skip}>
              {t('onboarding.skip')}
            </Button>
            <Button variant="primary" glass onClick={next}>
              {t('onboarding.next')}
            </Button>
          </div>
        </div>
        <div className="sk-onboarding-welcome__footer">{aboutFooter}</div>
      </motion.div>
    </div>
  );
}
