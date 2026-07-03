/**
 * Indeterminate activity spinner. Generic primitive (no product knowledge).
 * Styling is token-based and co-located in Spinner.scss; see design-system.md
 * Section 8.10.
 */
import { cx } from '../../lib';
import './Spinner.scss';

export interface SpinnerProps {
  /** Accessible status label announced to assistive tech. Defaults to "Loading". */
  readonly label?: string;
  /** Hide the label visually (still announced) for an icon-only spinner. */
  readonly labelHidden?: boolean;
}

export function Spinner({ label = 'Loading', labelHidden = false }: SpinnerProps) {
  return (
    <span className="sk-spinner" role="status" aria-live="polite">
      <span className="sk-spinner__ring" aria-hidden="true" />
      <span className={cx('sk-spinner__label', labelHidden && 'sk-spinner__label--hidden')}>{label}</span>
    </span>
  );
}
