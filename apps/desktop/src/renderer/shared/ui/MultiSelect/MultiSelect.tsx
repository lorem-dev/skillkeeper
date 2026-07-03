/**
 * MultiSelect: a fixed-width pop-up trigger showing the selected labels, opening
 * a Menu as a multiselectable listbox. When the joined labels do not fit, the
 * trigger falls back to a caller-supplied summary ("Selected N"). Generic -- no
 * product knowledge; text via props.
 */
import { useLayoutEffect, useRef, useState } from 'react';
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
  /** Fallback shown when the joined labels do not fit (e.g. `(n) => "Selected " + n`). */
  readonly summary?: (count: number) => ReactNode;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  summary,
  ariaLabel,
  disabled,
  className,
}: MultiSelectProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);

  const selectedLabels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const joined = selectedLabels.join(', ');

  // Does the joined text fit? The hidden measure span holds the full nowrap text
  // (natural width); compare to the value span's available width. Decoupled from
  // what is displayed, so switching to the summary does not oscillate.
  useLayoutEffect(() => {
    const v = valueRef.current;
    const m = measureRef.current;
    if (v === null || m === null) {
      setOverflow(false);
      return;
    }
    setOverflow(m.scrollWidth > v.clientWidth);
  }, [joined]);

  const toggle = (v: string): void =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const items: MenuItem[] = options.map((o) => ({
    id: o.value,
    label: o.label,
    icon: o.icon,
    selected: value.includes(o.value),
    onSelect: () => toggle(o.value),
  }));

  const hasSelection = selectedLabels.length > 0;
  const showSummary = hasSelection && overflow && summary !== undefined;

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
        <span ref={valueRef} className="sk-multiselect__value">
          {!hasSelection ? placeholder : showSummary ? summary(selectedLabels.length) : joined}
        </span>
        {hasSelection && (
          <span ref={measureRef} className="sk-multiselect__measure" aria-hidden="true">
            {joined}
          </span>
        )}
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
