/**
 * SplitButton: a primary (left) action button paired with a chevron toggle
 * that opens a dropdown menu of related actions. Generic -- no product
 * knowledge.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip';
import { Icon } from '../Icon';
import './SplitButton.scss';

export interface SplitButtonItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
}

export interface SplitButtonProps {
  /** Leading content of the primary (left) button. */
  readonly icon?: ReactNode;
  /** Tooltip / accessible name for the primary button. */
  readonly tooltip: string;
  /** Primary (left) action. */
  readonly onPrimary: () => void;
  /** Dropdown menu items. */
  readonly items: readonly SplitButtonItem[];
  /** Accessible name for the dropdown menu. */
  readonly menuLabel: string;
  readonly disabled?: boolean;
}

export function SplitButton({ icon, tooltip, onPrimary, items, menuLabel, disabled }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="sk-split-button">
      <Tooltip content={tooltip} disabled={open}>
        <button
          type="button"
          className="sk-split-button__primary"
          onClick={onPrimary}
          disabled={disabled}
          aria-label={tooltip}
        >
          <span className="sk-split-button__primary-icon">{icon}</span>
        </button>
      </Tooltip>
      <button
        type="button"
        className="sk-split-button__toggle"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={menuLabel}
      >
        <Icon name="chevron-right" className="sk-split-button__chevron" />
      </button>
      {open && (
        <ul id={menuId} role="menu" className="sk-split-button__menu">
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="sk-split-button__item"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="sk-split-button__item-icon">{item.icon}</span>
                <span className="sk-split-button__item-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
