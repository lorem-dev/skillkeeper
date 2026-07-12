/**
 * Menu: a floating list of items rendered in a portal, positioned against an
 * anchor and kept inside the window (with a capped, scrollable height). Generic
 * -- no product knowledge; the consumer owns the `open` state and selection
 * (each item carries `selected`/`onSelect`). Works as a `menu` (actions /
 * checkable items) or a `listbox` (single or multiselectable). See
 * design-system.md Section 8.8.
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
  /** Shows a leading checkmark and marks the item selected (for a11y state). */
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export type MenuPlacement = 'bottom' | 'top' | 'auto';
export type MenuRole = 'menu' | 'listbox';

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
  /** ARIA container role. 'menu' (default) for actions/checkables; 'listbox' for selects. */
  readonly role?: MenuRole;
  /** Only meaningful for role='listbox': sets aria-multiselectable. */
  readonly multiselectable?: boolean;
  /** Accessible name for the list. */
  readonly ariaLabel?: string;
  readonly className?: string;
}

const GAP = 4;
const EDGE_MARGIN = 8;
const MAX_HEIGHT = 360;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

interface Position {
  readonly top: number;
  readonly left: number;
  readonly side: 'bottom' | 'top';
  readonly maxHeight: number;
}

function computePosition(anchor: DOMRect, menuW: number, menuH: number, placement: MenuPlacement): Position {
  const below = window.innerHeight - anchor.bottom - GAP - EDGE_MARGIN;
  const above = anchor.top - GAP - EDGE_MARGIN;
  let side: 'bottom' | 'top';
  if (placement === 'bottom') side = 'bottom';
  else if (placement === 'top') side = 'top';
  else side = menuH <= below || below >= above ? 'bottom' : 'top';
  const room = side === 'bottom' ? below : above;
  const maxHeight = clamp(room, 0, MAX_HEIGHT);
  const height = Math.min(menuH, maxHeight);
  const top = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - height;
  const left = clamp(anchor.left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - menuW);
  return { top, left, side, maxHeight };
}

export function Menu({
  open,
  onClose,
  anchorRef,
  items,
  closeOnSelect = true,
  placement = 'auto',
  role = 'menu',
  multiselectable,
  ariaLabel,
  className,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [pos, setPos] = useState<Position | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items.some((it) => it.selected !== undefined);
  const enabledIndexes = items.map((it, i) => (it.disabled === true ? -1 : i)).filter((i) => i >= 0);

  // Position against the anchor once measurable; recompute on resize/scroll.
  // scrollHeight (not offsetHeight) gives the natural height so the applied
  // max-height cap does not feed back into the measurement.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = (): void => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      const list = listRef.current;
      if (anchor === null || menu === null || list === null) return;
      // Measure the scrolling list's content height (scrollHeight) so the cap
      // does not feed back; width from the outer frame.
      setPos(computePosition(anchor.getBoundingClientRect(), menu.offsetWidth, list.scrollHeight, placement));
    };
    place();
    // Coalesce scroll/resize bursts into one reposition per frame (each reads
    // layout and re-renders the portal).
    let raf = 0;
    const onChange = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [open, placement, anchorRef, items.length]);

  // Focus the menu on open; return focus to the anchor on close.
  useEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    setActiveIndex(-1);
    listRef.current?.focus();
    return () => {
      anchor?.focus();
    };
  }, [open, anchorRef]);

  // Keep the active item scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

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
    maxHeight: pos?.maxHeight,
    visibility: pos === null ? 'hidden' : 'visible',
    transformOrigin: pos?.side === 'top' ? 'bottom left' : 'top left',
  };

  const isListbox = role === 'listbox';

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          className={cx('sk-menu', className)}
          style={style}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } }}
        >
          <div
            ref={listRef}
            role={role}
            aria-label={ariaLabel}
            aria-multiselectable={isListbox ? multiselectable : undefined}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            tabIndex={-1}
            className="sk-menu__list"
            onKeyDown={onKeyDown}
          >
            {items.map((item, i) => {
            const itemRole = isListbox
              ? 'option'
              : item.selected === undefined
                ? 'menuitem'
                : 'menuitemcheckbox';
            return (
              <div
                key={item.id}
                id={`${listId}-${i}`}
                role={itemRole}
                aria-selected={isListbox ? (item.selected ?? false) : undefined}
                aria-checked={!isListbox && item.selected !== undefined ? item.selected : undefined}
                aria-disabled={item.disabled}
                className={cx(
                  'sk-menu__item',
                  i === activeIndex && 'sk-menu__item--active',
                  item.selected === true && 'sk-menu__item--selected',
                )}
                onMouseEnter={() => {
                  if (item.disabled !== true) setActiveIndex(i);
                }}
                onClick={() => choose(i)}
              >
                {selectable && (
                  <span className="sk-menu__check" aria-hidden="true">
                    {item.selected === true ? <Icon name="check" size={16} /> : null}
                  </span>
                )}
                {item.icon !== undefined && <span className="sk-menu__icon">{item.icon}</span>}
                <span className="sk-menu__label">{item.label}</span>
              </div>
            );
          })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
