/**
 * SplitButton: a primary (left) action button paired with a chevron toggle
 * that opens a dropdown menu of related actions (the shared Menu). Generic --
 * no product knowledge.
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import { Tooltip } from '../Tooltip';
import { Icon } from '../Icon';
import { Menu } from '../Menu';
import type { MenuItem } from '../Menu';
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
  /**
   * 'default' is the standard toolbar size. 'compact' matches the round icon
   * buttons: control-height segments with the same larger corner radius, so it
   * sits flush beside an icon button (e.g. Edit) on a card.
   */
  readonly size?: 'default' | 'compact';
}

export function SplitButton({ icon, tooltip, onPrimary, items, menuLabel, disabled, size = 'default' }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const menuItems: MenuItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    onSelect: item.onSelect,
  }));

  return (
    <div
      className={cx(
        'sk-split-button',
        size === 'compact' && 'sk-split-button--compact',
        open && 'sk-split-button--open',
      )}
    >
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
        ref={toggleRef}
        type="button"
        className="sk-split-button__toggle"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuLabel}
      >
        <Icon name="chevron-right" className="sk-split-button__chevron" />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={toggleRef}
        items={menuItems}
        ariaLabel={menuLabel}
      />
    </div>
  );
}
