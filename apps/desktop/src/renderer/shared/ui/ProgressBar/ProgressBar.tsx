/**
 * Progress bar. Determinate when `value` (0..1) is given, indeterminate when it
 * is omitted. Generic -- no product knowledge. See design-system.md Section 8.10.
 */
import { cx } from '../../lib';
import './ProgressBar.scss';

export interface ProgressBarProps {
  /** Progress fraction 0..1. Omit for an indeterminate bar. */
  readonly value?: number;
  /** Accessible label. */
  readonly label?: string;
  readonly className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cx('sk-progress', indeterminate && 'sk-progress--indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
    >
      <div className="sk-progress__fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
