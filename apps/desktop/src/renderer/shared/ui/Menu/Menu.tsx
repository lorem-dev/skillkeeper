/**
 * Menu: a floating list of items rendered in a portal, positioned against an
 * anchor and kept inside the window. Generic -- no product knowledge; the
 * consumer owns the `open` state and selection (each item carries
 * `selected`/`onSelect`). See design-system.md Section 8.8.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import { Icon } from '../Icon';
import './Menu.scss';

export interface MenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  /** Shows a leading checkmark; renders the item as menuitemcheckbox. */
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export type MenuPlacement = 'bottom' | 'top' | 'auto';

export interface MenuProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Trigger element the menu positions against. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly items: readonly MenuItem[];
  /** Close after an item is selected. Default true; multi-select passes false. */
  readonly closeOnSelect?: boolean;
  /** Preferred side; 'auto' (default) flips to fit the window. */
  readonly placement?: MenuPlacement;
  /** Accessible name for the list. */
  readonly ariaLabel?: string;
  readonly className?: string;
}

const GAP = 4;
const EDGE_MARGIN = 8;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

interface Position {
  readonly top: number;
  readonly left: number;
  readonly side: 'bottom' | 'top';
}

function computePosition(
  anchor: DOMRect,
  menuW: number,
  menuH: number,
  placement: MenuPlacement,
): Position {
  const below = window.innerHeight - anchor.bottom;
  const above = anchor.top;
  const needed = menuH + GAP + EDGE_MARGIN;
  let side: 'bottom' | 'top';
  if (placement === 'bottom') side = 'bottom';
  else if (placement === 'top') side = 'top';
  else side = below >= needed || below >= above ? 'bottom' : 'top';
  const top = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - menuH;
  const left = clamp(anchor.left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - menuW);
  return { top, left, side };
}

export function Menu({
  open,
  onClose,
  anchorRef,
  items,
  closeOnSelect = true,
  placement = 'auto',
  ariaLabel,
  className,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [pos, setPos] = useState<Position | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items.some((it) => it.selected !== undefined);
  const enabledIndexes = items
    .map((it, i) => (it.disabled === true ? -1 : i))
    .filter((i) => i >= 0);

  // Position against the anchor once the menu is measurable; recompute on
  // resize/scroll while open. offsetWidth/Height work under visibility:hidden.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = (): void => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor === null || menu === null) return;
      setPos(
        computePosition(anchor.getBoundingClientRect(), menu.offsetWidth, menu.offsetHeight, placement),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, placement, anchorRef, items.length]);

  // Focus the menu on open; return focus to the anchor on close.
  useEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    setActiveIndex(-1);
    menuRef.current?.focus();
    return () => {
      anchor?.focus();
    };
  }, [open, anchorRef]);

  // Close on a click outside the menu and the anchor.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  // No early return on !open: always render the portal + AnimatePresence and
  // gate the panel on `open`, so the exit animation runs (mirrors Modal).
  const setActive = (index: number | undefined): void => {
    if (index !== undefined) setActiveIndex(index);
  };

  const move = (delta: number): void => {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const nextPos =
      current === -1
        ? delta > 0
          ? 0
          : enabledIndexes.length - 1
        : (current + delta + enabledIndexes.length) % enabledIndexes.length;
    setActive(enabledIndexes[nextPos]);
  };

  const choose = (index: number): void => {
    const item = items[index];
    if (item === undefined || item.disabled === true) return;
    item.onSelect();
    if (closeOnSelect) onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(enabledIndexes[0]);
        break;
      case 'End':
        e.preventDefault();
        setActive(enabledIndexes[enabledIndexes.length - 1]);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIndex >= 0) choose(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos === null ? 'hidden' : 'visible',
    transformOrigin: pos?.side === 'top' ? 'bottom left' : 'top left',
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          tabIndex={-1}
          className={cx('sk-menu', className)}
          style={style}
          onKeyDown={onKeyDown}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } }}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              id={`${listId}-${i}`}
              type="button"
              role={item.selected === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.selected}
              aria-disabled={item.disabled}
              disabled={item.disabled}
              className={cx(
                'sk-menu__item',
                i === activeIndex && 'sk-menu__item--active',
                item.selected === true && 'sk-menu__item--selected',
              )}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(i)}
            >
              {selectable && (
                <span className="sk-menu__check" aria-hidden="true">
                  {item.selected === true ? <Icon name="check" size={16} /> : null}
                </span>
              )}
              {item.icon !== undefined && <span className="sk-menu__icon">{item.icon}</span>}
              <span className="sk-menu__label">{item.label}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
