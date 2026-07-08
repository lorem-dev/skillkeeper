/**
 * Generic button primitive. No product knowledge -- lives in shared/ui.
 *
 * Variants follow the design system (docs/ui/design-system.md, Section 8.2);
 * the look is defined in the co-located Button.scss using design tokens.
 */
import { useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx, useGlassRefraction } from '../../lib';
import './Button.scss';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tinted'
  | 'plain'
  | 'destructive'
  | 'glass';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Defaults to `secondary`. */
  readonly variant?: ButtonVariant;
  /**
   * Overlay the refractive glass-surface treatment (translucent tint, backdrop
   * refraction, gradient rim) on top of the variant's colouring. Composes with
   * any variant -- e.g. `variant="primary" glass` is a frosted primary. The
   * standalone `variant="glass"` is the accent-on-thin-glass look and already
   * implies this treatment.
   */
  readonly glass?: boolean;
  /**
   * Shows a skeleton shimmer over the button and makes it non-interactive --
   * e.g. while a background task the button started is still running.
   */
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = 'secondary',
  glass = false,
  loading = false,
  disabled,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // Glass gets the same backdrop refraction as the other glass surfaces -- either
  // via the standalone `glass` variant or the `glass` prop layered over another
  // variant. A gentle, small-radius look suits a control.
  const isGlass = glass || variant === 'glass';
  useGlassRefraction(ref, { enabled: isGlass, depth: 6, strength: 30 });
  return (
    <button
      ref={ref}
      // A constant union; the lint rule for static button type is satisfied.
      type={type}
      className={cx(
        'sk-button',
        `sk-button--${variant}`,
        glass && 'sk-button--glass-surface',
        loading && 'sk-button--loading',
        className,
      )}
      // Loading is non-interactive: disable it so it cannot be clicked or focused.
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
      {loading && <span className="sk-button__shimmer" aria-hidden="true" />}
    </button>
  );
}
