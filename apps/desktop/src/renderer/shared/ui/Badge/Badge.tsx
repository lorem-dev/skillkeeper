/**
 * Badge / status pill. Generic -- no product knowledge.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Badge.scss';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  /** Allow the label text to be selected. Off by default. */
  readonly selectable?: boolean;
  readonly className?: string;
  /** Test id for the badge element. Generic passthrough -- Badge has no
   *  product knowledge of it, a caller sets it for the flows that need it. */
  readonly 'data-testid'?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  selectable = false,
  className,
  'data-testid': testId,
}: BadgeProps) {
  return (
    <span
      className={cx('sk-badge', `sk-badge--${tone}`, selectable && 'sk-badge--selectable', className)}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
