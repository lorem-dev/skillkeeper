/**
 * MultiCombobox: a text input that filters a list of options by what is typed
 * and toggles MANY selections (a "multi-select with search"). Like Combobox but
 * selecting an option toggles it and keeps the list open; while idle it shows
 * the joined selected labels (or a placeholder). Generic -- no product
 * knowledge; text via props. The list is a portal positioned against the input.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import { Icon } from '../Icon';
import './MultiCombobox.scss';

export interface MultiComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface MultiComboboxProps {
  /** Optional label rendered above the control. */
  readonly label?: ReactNode;
  readonly options: readonly MultiComboboxOption[];
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  /** Message shown in the list when no option matches the query. */
  readonly emptyText?: string;
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

export function MultiCombobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  emptyText,
  className,
}: MultiComboboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listId = useId();

  const valueSet = useMemo(() => new Set(value), [value]);
  const summary = useMemo(
    () => options.filter((o) => valueSet.has(o.value)).map((o) => o.label).join(', '),
    [options, valueSet],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<Position | null>(null);

  // While idle, the input reflects the current selection (joined labels).
  useEffect(() => {
    if (!open) setQuery(summary);
  }, [open, summary]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const enabledIndexes = filtered.map((o, i) => (o.disabled === true ? -1 : i)).filter((i) => i >= 0);

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
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, filtered.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

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
    // Clear to an empty query so the full list shows and typing filters live.
    setQuery('');
    setActiveIndex(-1);
    setOpen(true);
  };

  const toggle = (index: number): void => {
    const option = filtered[index];
    if (option === undefined || option.disabled === true) return;
    const next = valueSet.has(option.value)
      ? value.filter((v) => v !== option.value)
      : [...value, option.value];
    onChange([...next]);
    // Keep the list open (and focused) so several can be toggled in a row.
    inputRef.current?.focus();
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
          toggle(activeIndex);
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

  const control = (
    <div className="sk-multicombobox__wrap">
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
        className="sk-multicombobox__input"
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={openList}
        onClick={openList}
        onKeyDown={onKeyDown}
      />
      <Icon name="chevron-right" className="sk-multicombobox__chevron" size={16} />
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popupRef}
              className="sk-multicombobox__popup"
              style={style}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } }}
            >
              <div ref={listRef} id={listId} role="listbox" aria-multiselectable="true" aria-label={ariaLabel} className="sk-multicombobox__list">
                {filtered.length === 0 ? (
                  <div className="sk-multicombobox__empty">{emptyText}</div>
                ) : (
                  filtered.map((o, i) => (
                    <div
                      key={o.value}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={valueSet.has(o.value)}
                      aria-disabled={o.disabled}
                      className={cx(
                        'sk-multicombobox__option',
                        i === activeIndex && 'sk-multicombobox__option--active',
                        valueSet.has(o.value) && 'sk-multicombobox__option--selected',
                      )}
                      // mousedown (not click) so it fires before the input blur.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        toggle(i);
                      }}
                      onMouseEnter={() => {
                        if (o.disabled !== true) setActiveIndex(i);
                      }}
                    >
                      <span className="sk-multicombobox__check" aria-hidden="true">
                        {valueSet.has(o.value) ? <Icon name="check" size={16} /> : null}
                      </span>
                      <span className="sk-multicombobox__option-label">{o.label}</span>
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
    <span className={cx('sk-multicombobox', className)}>
      {label !== undefined && (
        <span id={labelId} className="sk-multicombobox__label">
          {label}
        </span>
      )}
      {control}
    </span>
  );
}
