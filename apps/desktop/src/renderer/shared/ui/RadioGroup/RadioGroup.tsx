/**
 * Radio group primitive. Controlled single-choice list of native radio inputs
 * with styled dots. Generic -- no product knowledge. See docs/ui/components.md.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './RadioGroup.scss';

export interface RadioOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface RadioGroupProps {
  /** Shared input name for the group. */
  readonly name: string;
  /** Currently selected value. */
  readonly value: string;
  readonly options: readonly RadioOption[];
  readonly onChange: (value: string) => void;
  /** Accessible group label. */
  readonly label?: string;
  readonly className?: string;
  /** Disables every option. */
  readonly disabled?: boolean;
}

export function RadioGroup({
  name,
  value,
  options,
  onChange,
  label,
  className,
  disabled,
}: RadioGroupProps) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('sk-radio-group', className)}>
      {options.map((o) => {
        const optDisabled = disabled === true || o.disabled === true;
        return (
          <label key={o.value} className={cx('sk-radio', optDisabled && 'sk-radio--disabled')}>
            <input
              type="radio"
              className="sk-radio__input"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={optDisabled}
              onChange={() => onChange(o.value)}
            />
            <span className="sk-radio__dot" aria-hidden="true" />
            <span className="sk-radio__label">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}
