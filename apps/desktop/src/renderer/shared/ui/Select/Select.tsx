/**
 * Select primitive. A styled native <select> (the open list stays OS-native for
 * accessibility) with a custom chevron. Pass `options` or <option> children.
 * Generic -- no product knowledge. See docs/ui/components.md.
 */
import type { SelectHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib';
import './Select.scss';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Optional label rendered above the control. */
  readonly label?: ReactNode;
  /** Convenience option list; alternatively pass <option> children. */
  readonly options?: readonly SelectOption[];
}

export function Select({ label, options, className, children, ...rest }: SelectProps) {
  const control = (
    <span className="sk-select__wrap">
      <select className="sk-select__input" {...rest}>
        {options !== undefined
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <span className="sk-select__chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12">
          <path
            d="M3 4.5 L6 7.5 L9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );

  if (label === undefined) {
    return <span className={cx('sk-select', className)}>{control}</span>;
  }

  return (
    <label className={cx('sk-select', className)}>
      <span className="sk-select__label">{label}</span>
      {control}
    </label>
  );
}
