/**
 * Checkbox primitive. A native checkbox input (kept for accessibility) with a
 * styled box drawn beside it. Generic -- no product knowledge.
 * See docs/ui/components.md and design-system.md Section 8.3.
 */
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib';
import './Checkbox.scss';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Optional label rendered next to the box. */
  readonly label?: ReactNode;
}

export function Checkbox({ label, className, disabled, ...rest }: CheckboxProps) {
  return (
    <label className={cx('sk-checkbox', disabled && 'sk-checkbox--disabled', className)}>
      <input type="checkbox" className="sk-checkbox__input" disabled={disabled} {...rest} />
      <span className="sk-checkbox__box" aria-hidden="true">
        <svg viewBox="0 0 12 12" className="sk-checkbox__check">
          <path
            d="M2.5 6.2 L4.8 8.5 L9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label !== undefined && <span className="sk-checkbox__label">{label}</span>}
    </label>
  );
}
