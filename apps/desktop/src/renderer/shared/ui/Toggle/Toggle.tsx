/**
 * Toggle / switch primitive. A native checkbox (role="switch") styled as a pill
 * track with a sliding knob. Generic -- no product knowledge.
 * See docs/ui/components.md and design-system.md Section 8.3.
 */
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib';
import './Toggle.scss';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Optional label rendered before the switch. */
  readonly label?: ReactNode;
}

export function Toggle({ label, className, disabled, ...rest }: ToggleProps) {
  return (
    <label className={cx('sk-toggle', disabled && 'sk-toggle--disabled', className)}>
      {label !== undefined && <span className="sk-toggle__label">{label}</span>}
      <input
        type="checkbox"
        role="switch"
        className="sk-toggle__input"
        disabled={disabled}
        {...rest}
      />
      <span className="sk-toggle__track" aria-hidden="true">
        <span className="sk-toggle__knob" />
      </span>
    </label>
  );
}
