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
}

export function Badge({ children, tone = 'neutral', selectable = false, className }: BadgeProps) {
  return (
    <span
      className={cx('sk-badge', `sk-badge--${tone}`, selectable && 'sk-badge--selectable', className)}
    >
      {children}
    </span>
  );
}
