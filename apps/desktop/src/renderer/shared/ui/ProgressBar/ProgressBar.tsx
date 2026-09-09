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
  /** Test id for the progressbar element. Generic passthrough -- ProgressBar
   *  has no product knowledge of it, a caller sets it for the flows that need
   *  it (e.g. to read `aria-valuenow` once a scripted progress event lands). */
  readonly 'data-testid'?: string;
}

export function ProgressBar({ value, label, className, 'data-testid': testId }: ProgressBarProps) {
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
      data-testid={testId}
    >
      <div className="sk-progress__fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
