/**
 * Checkbox primitive. A native checkbox input (kept for accessibility) with a
 * styled box drawn beside it. Generic -- no product knowledge.
 * See docs/ui/components.md and design-system.md Section 8.3.
 */
import { useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib';
import './Checkbox.scss';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Optional label rendered next to the box. */
  readonly label?: ReactNode;
  /**
   * Third ("mixed") state: shows a dash instead of a check. Sets the native
   * `indeterminate` DOM property, which the `:indeterminate` styles key off.
   * Takes visual precedence over `checked`.
   */
  readonly indeterminate?: boolean;
}

export function Checkbox({
  label,
  className,
  disabled,
  indeterminate = false,
  checked,
  ...rest
}: CheckboxProps) {
  // `indeterminate` is a DOM property, not an attribute, so it must be set on
  // the element directly (also kept in sync for assistive tech).
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={cx(
        'sk-checkbox',
        disabled && 'sk-checkbox--disabled',
        indeterminate && 'sk-checkbox--indeterminate',
        // Class-drive the checked visual for controlled use so it never desyncs
        // from the native `:checked` state (e.g. after leaving indeterminate);
        // uncontrolled checkboxes fall back to `:checked` below.
        checked === true && !indeterminate && 'sk-checkbox--checked',
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        className="sk-checkbox__input"
        disabled={disabled}
        checked={checked}
        {...rest}
      />
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
        <svg viewBox="0 0 12 12" className="sk-checkbox__dash">
          <path d="M3 6 L9 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      {label !== undefined && <span className="sk-checkbox__label">{label}</span>}
    </label>
  );
}
