/**
 * MultiSelect: a pop-up trigger showing the selected labels, opening a Menu as a
 * multiselectable listbox. Generic -- no product knowledge; text via props.
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import { Menu } from '../Menu';
import type { MenuItem } from '../Menu';
import { Icon } from '../Icon';
import './MultiSelect.scss';

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface MultiSelectProps {
  readonly options: readonly MultiSelectOption[];
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  /** Shown on the trigger when nothing is selected. */
  readonly placeholder?: ReactNode;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  className,
}: MultiSelectProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const selectedLabels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const toggle = (v: string): void =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const items: MenuItem[] = options.map((o) => ({
    id: o.value,
    label: o.label,
    icon: o.icon,
    selected: value.includes(o.value),
    onSelect: () => toggle(o.value),
  }));

  return (
    <span className={cx('sk-multiselect', className)}>
      <button
        ref={anchorRef}
        type="button"
        className="sk-multiselect__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sk-multiselect__value">
          {selectedLabels.length > 0 ? selectedLabels.join(', ') : placeholder}
        </span>
        <Icon name="chevron-right" className="sk-multiselect__chevron" size={16} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        items={items}
        role="listbox"
        multiselectable
        closeOnSelect={false}
        ariaLabel={ariaLabel}
      />
    </span>
  );
}
