/**
 * Combobox: a text input that filters a list of options by what is typed and
 * commits a single selection (a "select with search"). Generic -- no product
 * knowledge; text via props. The input keeps focus while the filtered list is
 * open (so typing narrows it live); arrows move the highlight, Enter commits,
 * Escape reverts. The list is a portal positioned against the input and kept
 * inside the window, mirroring Menu. See design-system.md.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import { Icon } from '../Icon';
import './Combobox.scss';

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Optional leading icon, shown in the list row and (for the selected option)
   * in the input. */
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  /** Optional label rendered above the control. */
  readonly label?: ReactNode;
  readonly options: readonly ComboboxOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  /** Message shown in the list when no option matches the query. */
  readonly emptyText?: string;
  /** Leading icon shown while there is no committed selection or the user is
   * typing (an "unknown" placeholder). Once a selection is idle, that option's
   * own `icon` replaces it. */
  readonly fallbackIcon?: ReactNode;
  /** Truncate the DISPLAYED label to this many chars (with an ellipsis). The
   * full label is still used for filtering, and the full value is committed. */
  readonly maxLabelLength?: number;
  readonly className?: string;
}

const GAP = 4;
const EDGE_MARGIN = 8;
const MAX_HEIGHT = 320;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

interface Position {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly side: 'bottom' | 'top';
  readonly maxHeight: number;
}

function computePosition(anchor: DOMRect, listH: number): Position {
  const below = window.innerHeight - anchor.bottom - GAP - EDGE_MARGIN;
  const above = anchor.top - GAP - EDGE_MARGIN;
  const side: 'bottom' | 'top' = listH <= below || below >= above ? 'bottom' : 'top';
  const room = side === 'bottom' ? below : above;
  const maxHeight = clamp(room, 0, MAX_HEIGHT);
  const height = Math.min(listH, maxHeight);
  const top = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - height;
  const left = clamp(anchor.left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - anchor.width);
  return { top, left, width: anchor.width, side, maxHeight };
}

export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  emptyText,
  fallbackIcon,
  maxLabelLength,
  className,
}: ComboboxProps) {
  const display = (text: string): string =>
    maxLabelLength !== undefined && text.length > maxLabelLength
      ? `${text.slice(0, maxLabelLength)}...`
      : text;
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listId = useId();

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Until the user types, show the whole list (not just the one exact match).
  const [dirty, setDirty] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<Position | null>(null);

  // Keep the input text reflecting the committed selection while idle (using the
  // truncated display form; the full label is shown for editing on focus).
  useEffect(() => {
    if (open) return;
    // Closing without committing reverts to the current selection: reset the
    // edit flag too, so the leading icon returns to the selected option's (not
    // the typing/unknown fallback).
    setDirty(false);
    const label = selected?.label ?? '';
    setQuery(
      maxLabelLength !== undefined && label.length > maxLabelLength
        ? `${label.slice(0, maxLabelLength)}...`
        : label,
    );
  }, [open, selected, maxLabelLength]);

  const filtered = useMemo(() => {
    if (!dirty) return options;
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, dirty]);

  const enabledIndexes = filtered.map((o, i) => (o.disabled === true ? -1 : i)).filter((i) => i >= 0);

  // Position against the input once measurable; recompute on resize/scroll.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = (): void => {
      const anchor = inputRef.current;
      const list = listRef.current;
      if (anchor === null || list === null) return;
      setPos(computePosition(anchor.getBoundingClientRect(), list.scrollHeight));
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
  }, [open, filtered.length]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  // Close on a click outside the input and the popup.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target) === true) return;
      if (inputRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const openList = (): void => {
    if (disabled === true) return;
    // Show the full selected label for editing/filtering while open.
    if (selected) setQuery(selected.label);
    setDirty(false);
    setActiveIndex(selected ? filtered.findIndex((o) => o.value === selected.value) : -1);
    setOpen(true);
  };

  const commit = (index: number): void => {
    const option = filtered[index];
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    setDirty(false);
    setOpen(false);
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
    setActiveIndex(enabledIndexes[nextPos] ?? -1);
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) move(-1);
        break;
      case 'Enter':
        if (open && activeIndex >= 0) {
          e.preventDefault();
          commit(activeIndex);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  };

  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    width: pos?.width,
    maxHeight: pos?.maxHeight,
    visibility: pos === null ? 'hidden' : 'visible',
    transformOrigin: pos?.side === 'top' ? 'bottom left' : 'top left',
  };

  // Leading adornment: the selected option's icon once a choice is committed and
  // idle; otherwise (no selection yet, or the user is typing) the fallback icon.
  const leadingIcon = selected !== undefined && !dirty ? selected.icon : fallbackIcon;
  const control = (
    <div className="sk-combobox__wrap">
      {leadingIcon !== undefined && (
        <span className="sk-combobox__leading" aria-hidden="true">
          {leadingIcon}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={label !== undefined ? labelId : undefined}
        className={cx('sk-combobox__input', leadingIcon !== undefined && 'sk-combobox__input--with-icon')}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setDirty(true);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={openList}
        onClick={openList}
        onKeyDown={onKeyDown}
      />
      <Icon name="chevron-right" className="sk-combobox__chevron" size={16} />
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popupRef}
              className="sk-combobox__popup"
              style={style}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } }}
            >
              <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="sk-combobox__list">
                {filtered.length === 0 ? (
                  <div className="sk-combobox__empty">{emptyText}</div>
                ) : (
                  filtered.map((o, i) => (
                    <div
                      key={o.value}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled}
                      className={cx(
                        'sk-combobox__option',
                        i === activeIndex && 'sk-combobox__option--active',
                        o.value === value && 'sk-combobox__option--selected',
                      )}
                      // mousedown (not click) so it fires before the input blur closes the popup.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commit(i);
                      }}
                      onMouseEnter={() => {
                        if (o.disabled !== true) setActiveIndex(i);
                      }}
                    >
                      <span className="sk-combobox__check" aria-hidden="true">
                        {o.value === value ? <Icon name="check" size={16} /> : null}
                      </span>
                      {o.icon !== undefined && (
                        <span className="sk-combobox__option-icon" aria-hidden="true">
                          {o.icon}
                        </span>
                      )}
                      <span className="sk-combobox__option-label">{display(o.label)}</span>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );

  return (
    <span className={cx('sk-combobox', className)}>
      {label !== undefined && (
        <span id={labelId} className="sk-combobox__label">
          {label}
        </span>
      )}
      {control}
    </span>
  );
}
