/**
 * Select primitive: a pop-up trigger showing the current value's label, opening
 * a Menu as a single-select listbox. Generic -- no product knowledge; text via
 * props. See docs/ui/components.md.
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import { Menu } from '../Menu';
import type { MenuItem } from '../Menu';
import { Icon } from '../Icon';
import './Select.scss';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  /** Optional label rendered above the control. */
  readonly label?: ReactNode;
  readonly options: readonly SelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Shown when `value` matches no option. */
  readonly placeholder?: ReactNode;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Select({ label, options, value, onChange, placeholder, ariaLabel, disabled, className }: SelectProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const current = options.find((o) => o.value === value);
  const items: MenuItem[] = options.map((o) => ({
    id: o.value,
    label: o.label,
    disabled: o.disabled,
    selected: o.value === value,
    onSelect: () => onChange(o.value),
  }));

  const control = (
    <span className="sk-select__wrap">
      <button
        ref={anchorRef}
        type="button"
        className="sk-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sk-select__value">{current?.label ?? placeholder}</span>
        <Icon name="chevron-right" className="sk-select__chevron" size={16} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        items={items}
        role="listbox"
        ariaLabel={ariaLabel}
      />
    </span>
  );

  if (label === undefined) {
    return <span className={cx('sk-select', className)}>{control}</span>;
  }

  return (
    <span className={cx('sk-select', className)}>
      <span className="sk-select__label">{label}</span>
      {control}
    </span>
  );
}
