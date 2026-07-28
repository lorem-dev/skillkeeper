/**
 * Single-line text input primitive. Generic -- no product knowledge.
 * See docs/ui/components.md and design-system.md Section 8.4.
 */
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../../lib';
import './TextField.scss';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional label rendered above the field. */
  readonly label?: ReactNode;
  /** Marks the field invalid (red border + aria-invalid). */
  readonly invalid?: boolean;
  /** Forwarded straight to the underlying `<input>` (React 19 plain-prop ref). */
  readonly ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, invalid, className, ...rest }: TextFieldProps) {
  const input = (
    <input
      className={cx('sk-textfield__input', invalid && 'sk-textfield__input--invalid')}
      aria-invalid={invalid === true ? true : undefined}
      {...rest}
    />
  );

  if (label === undefined) {
    return <span className={cx('sk-textfield', className)}>{input}</span>;
  }

  return (
    <label className={cx('sk-textfield', className)}>
      <span className="sk-textfield__label">{label}</span>
      {input}
    </label>
  );
}
