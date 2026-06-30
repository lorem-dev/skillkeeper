/**
 * Indeterminate activity spinner. Generic primitive (no product knowledge).
 * Styling is token-based and co-located in Spinner.scss; see design-system.md
 * Section 8.10.
 */
import './Spinner.scss';

export interface SpinnerProps {
  /** Accessible status label announced to assistive tech. Defaults to "Loading". */
  readonly label?: string;
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <span className="sk-spinner" role="status" aria-live="polite">
      <span className="sk-spinner__ring" aria-hidden="true" />
      <span className="sk-spinner__label">{label}</span>
    </span>
  );
}
