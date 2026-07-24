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
}

/**
 * Onboarding step 1: an opaque full-screen layer. The identity block and a
 * compact, labelled language/theme list sit centered; the About footer is
 * pinned to the bottom. The controls write straight to config, same as
 * `pages/Settings/SettingsPage.tsx`.
 */
export function WelcomeScreen({ aboutIdentity, aboutFooter }: WelcomeScreenProps) {
  const t = useTranslator();
  const config = useSkillkeeperStore((s) => s.config);
  const { next } = useOnboardingActions();
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
        </FormSection>
        <Button variant="primary" glass onClick={next}>
          {t('onboarding.next')}
        </Button>
      </div>
      <div className="sk-onboarding-welcome__footer">{aboutFooter}</div>
      </motion.div>
    </div>
  );
}
