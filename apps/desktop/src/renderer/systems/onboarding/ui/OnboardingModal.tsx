import type { ReactNode } from 'react';
import { Button } from '@/shared/ui';
import './OnboardingModal.scss';

export interface OnboardingModalProps {
  readonly children: ReactNode;
  readonly onNext: () => void;
  readonly nextLabel: string;
  readonly onBack?: () => void;
  readonly backLabel?: string;
}

/**
 * A centered, full-screen overlay card for an onboarding step. Intentionally
 * has NO backdrop-click handler: the tour advances only via the Next/Finish
 * button (and the overlay's shared Skip control), never by clicking outside.
 */
export function OnboardingModal({ children, onNext, nextLabel, onBack, backLabel }: OnboardingModalProps) {
  return (
    <div className="sk-onboarding-modal" role="dialog" aria-modal="true">
      <div className="sk-onboarding-modal__card">
        <div className="sk-onboarding-modal__body">{children}</div>
        <div className="sk-onboarding-modal__actions">
          {onBack !== undefined && backLabel !== undefined && (
            <Button variant="secondary" onClick={onBack}>
              {backLabel}
            </Button>
          )}
          <Button variant="primary" glass onClick={onNext}>
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
