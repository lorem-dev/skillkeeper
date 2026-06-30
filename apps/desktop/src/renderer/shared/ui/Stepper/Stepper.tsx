/**
 * Stepper: a numeric value with decrement / increment buttons. Generic -- no
 * product knowledge. See design-system.md Section 8.3.
 *
 * Per the i18n rule, the button accessible names are passed in (translated by the
 * caller); the English defaults are developer fallbacks only.
 */
import { cx } from '../../lib';
import './Stepper.scss';

export interface StepperProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  /** Accessible group label. */
  readonly label?: string;
  /** Accessible name for the decrement button. */
  readonly decreaseLabel?: string;
  /** Accessible name for the increment button. */
  readonly increaseLabel?: string;
  readonly className?: string;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  label,
  decreaseLabel = 'Decrease',
  increaseLabel = 'Increase',
  className,
}: StepperProps) {
  const atMin = min !== undefined && value <= min;
  const atMax = max !== undefined && value >= max;
  return (
    <div className={cx('sk-stepper', className)} role="group" aria-label={label}>
      <button
        type="button"
        className="sk-stepper__btn"
        onClick={() => onChange(clamp(value - step, min, max))}
        disabled={disabled === true || atMin}
        aria-label={decreaseLabel}
      >
        -
      </button>
      <span className="sk-stepper__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="sk-stepper__btn"
        onClick={() => onChange(clamp(value + step, min, max))}
        disabled={disabled === true || atMax}
        aria-label={increaseLabel}
      >
        +
      </button>
    </div>
  );
}
