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
   * Shows a skeleton shimmer over the button and makes it non-interactive --
   * e.g. while a background task the button started is still running.
   */
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // The glass variant gets the same backdrop refraction as the other glass
  // surfaces; a gentle, small-radius look suits a control.
  useGlassRefraction(ref, { enabled: variant === 'glass', depth: 6, strength: 30 });
  return (
    <button
      ref={ref}
      // A constant union; the lint rule for static button type is satisfied.
      type={type}
      className={cx('sk-button', `sk-button--${variant}`, loading && 'sk-button--loading', className)}
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
