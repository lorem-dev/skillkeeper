/**
 * Search field: a pill input with a leading magnifier and a trailing clear
 * button (shown when controlled with a non-empty value). Desktop pattern from
 * the desktop reference. Generic -- no product knowledge. See components.md.
 *
 * Per the i18n rule, the clear button's accessible name is passed in (translated
 * by the caller); the English default is a developer fallback.
 */
import type { InputHTMLAttributes } from 'react';
import { cx } from '../../lib';
import './SearchField.scss';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Called when the clear button is pressed. */
  readonly onClear?: () => void;
  /** Accessible name for the clear button. */
  readonly clearLabel?: string;
}

export function SearchField({
  value,
  onClear,
  clearLabel = 'Clear',
  className,
  ...rest
}: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;
  return (
    <div className={cx('sk-search', className)}>
      <span className="sk-search__icon" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="10.5"
            y1="10.5"
            x2="14"
            y2="14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input type="search" className="sk-search__input" value={value} {...rest} />
      {hasValue && onClear !== undefined && (
        <button type="button" className="sk-search__clear" aria-label={clearLabel} onClick={onClear}>
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="8" fill="currentColor" />
            <path
              d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
              stroke="var(--sk-color-bg-tertiary)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
