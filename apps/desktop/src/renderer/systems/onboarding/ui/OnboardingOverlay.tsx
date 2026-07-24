import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Button, ChangeBadge } from '@/shared/ui';
import { dragRegion } from '@/shared/lib';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import { useOnboardingActive, useOnboardingStep, useOnboardingActions } from '../model/useOnboarding';
import { STEP_META } from '../model/steps';
import type { StepId } from '../model/steps';
import type { DemoTreeVariant } from '../model/demoTree';
import { useAnchorRect } from '../lib/measureAnchor';
import { interleaveIcons } from '../lib/interleaveIcons';
import { WelcomeScreen } from './WelcomeScreen';
import { Coachmark } from './Coachmark';
import { OnboardingModal } from './OnboardingModal';
import './OnboardingOverlay.scss';

const DOCS_PROJECTS = 'https://lorem-dev.github.io/skillkeeper/latest/usage/projects/';
const DOCS_REPOSITORIES = 'https://lorem-dev.github.io/skillkeeper/latest/usage/repositories/';

// Spotlight steps that carry an external documentation link on their coachmark.
const STEP_DOC: Partial<Record<StepId, { readonly href: string; readonly labelKey: 'onboarding.projects.docs' | 'onboarding.repositories.docs' }>> = {
  projects: { href: DOCS_PROJECTS, labelKey: 'onboarding.projects.docs' },
  repositories: { href: DOCS_REPOSITORIES, labelKey: 'onboarding.repositories.docs' },
};

export interface OnboardingOverlayProps {
  /** The About identity (logo/name/version), injected by the caller so this
   *  system never imports `features/about` directly. Shown at the top of the
   *  `welcome` step. */
  readonly aboutIdentity: ReactNode;
  /** The About footer (docs/repo/license links + copyright), pinned to the
   *  bottom of the `welcome` step. */
  readonly aboutFooter: ReactNode;
  /** Renders the real, read-only `TreeView` demo fixture for the skills and
   *  agents steps, injected by the caller so this system never imports
   *  `features/onboardingDemo` (or the `entities` it composes) directly. */
  readonly renderDemoTree: (variant: DemoTreeVariant) => ReactNode;
}

/**
 * The onboarding tour's root layer. Renders `null` when the tour is inactive;
 * otherwise a full-screen dim scrim (captures every pointer event so the app
 * beneath is fully inert), a persistent bottom-left Skip control (every step
 * except `welcome`/`done`), and the current step's content: the welcome
 * screen, a spotlight ring + coachmark anchored to a live control, or a
 * centered modal.
 */
export function OnboardingOverlay({ aboutIdentity, aboutFooter, renderDemoTree }: OnboardingOverlayProps) {
  const active = useOnboardingActive();
  const step = useOnboardingStep();
  const { next, back, skip } = useOnboardingActions();
  const t = useTranslator();
  const meta = STEP_META[step];
  const rect = useAnchorRect(meta.kind === 'spotlight' ? meta.anchorId : undefined);

  // Escape ends the tour (same as the Skip control), while it is active.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, skip]);

  if (!active) return null;

  const showSkip = step !== 'welcome' && step !== 'done';
  // Non-empty only under the macOS frameless chrome; used to render a top drag
  // handle so the window stays movable while the overlay covers the top.
  const dragProps = dragRegion();
  // The current spotlight step's optional documentation link, if any.
  const doc = STEP_DOC[step];
  // The spotlight coachmark body: the page-intro sentence + the button
  // instruction combined into one card (merged from the former separate steps).
  const spotlightBody =
    step === 'projects' ? (
      <>
        {t('onboarding.projects-tab.body')} {t('onboarding.projects.body')}
      </>
    ) : step === 'repositories' ? (
      <>
        {t('onboarding.repositories-tab.body')} {t('onboarding.repositories.body')}
      </>
    ) : null;

  return (
    <div className="sk-onboarding" role="presentation">
      {/* Dim layer: captures ALL pointer events so the app beneath is inert. */}
      <div className="sk-onboarding__scrim" />

      {/* macOS has no in-webview title bar (native traffic lights), so the
          overlay covers the top drag region -- provide a drag handle along the
          top so the window can still be moved. dragRegion() is non-empty only
          under the macOS chrome, so the strip is a mac-only, inert handle. */}
      {dragProps['data-tauri-drag-region'] === true && (
        <div className="sk-onboarding__drag" {...dragProps} aria-hidden="true" />
      )}

      {step === 'welcome' && (
        <WelcomeScreen aboutIdentity={aboutIdentity} aboutFooter={aboutFooter} />
      )}

      {meta.kind === 'spotlight' && (
        <>
          {rect !== null && (
            <div
              className="sk-onboarding__spotlight"
              style={{
                top: rect.top - 6,
                left: rect.left - 6,
                width: rect.width + 12,
                height: rect.height + 12,
              }}
              aria-hidden="true"
            />
          )}
          <Coachmark
            rect={rect}
            body={spotlightBody}
            docHref={doc?.href}
            docLabel={doc !== undefined ? t(doc.labelKey) : undefined}
            onDocClick={(href) => void bridgeClient.openExternal(href)}
            onNext={next}
            nextLabel={t('onboarding.next')}
            onBack={back}
            backLabel={t('onboarding.back')}
          />
        </>
      )}

      {meta.kind === 'modal' && (
        <OnboardingModal
          onNext={next}
          nextLabel={step === 'done' ? t('onboarding.finish') : t('onboarding.next')}
          onBack={step === 'done' ? undefined : back}
          backLabel={step === 'done' ? undefined : t('onboarding.back')}
        >
          {(step === 'skills-intro' || step === 'skills-actions') && (
            <>
              <p className="sk-onboarding__intro">{t('onboarding.skills-tab.body')}</p>
              {renderDemoTree(step === 'skills-intro' ? 'skills-installed' : 'skills-actions')}
              <p className="sk-onboarding__legend">
                {step === 'skills-intro'
                  ? interleaveIcons(t('onboarding.skills-intro.body'), {
                      installed: <ChangeBadge kind="present" label={t('skills.status.present')} />,
                    })
                  : interleaveIcons(t('onboarding.skills-actions.body'), {
                      remove: <ChangeBadge kind="remove" label={t('skills.status.remove')} />,
                      install: <ChangeBadge kind="add" label={t('skills.status.add')} />,
                    })}
              </p>
            </>
          )}
          {step === 'agents' && (
            <>
              <p className="sk-onboarding__intro">{t('onboarding.skills-tab.body')}</p>
              {renderDemoTree('agents')}
              <p className="sk-onboarding__legend">{t('onboarding.agents.body')}</p>
            </>
          )}
          {step === 'done' && (
            <>
              <h2 className="sk-onboarding__done-title">{t('onboarding.done.title')}</h2>
              <p className="sk-onboarding__done-body">{t('onboarding.done.body')}</p>
              <p className="sk-onboarding__done-hint">{t('onboarding.done.hint')}</p>
            </>
          )}
        </OnboardingModal>
      )}

      {showSkip && (
        <div className="sk-onboarding__skip">
          <Button variant="secondary" glass onClick={skip}>
            {t('onboarding.skip')}
          </Button>
        </div>
      )}
    </div>
  );
}
