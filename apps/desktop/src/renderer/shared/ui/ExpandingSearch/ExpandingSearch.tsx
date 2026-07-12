/**
 * Expanding search: a round icon button (a centred magnifier) that grows into a
 * full search field on click or focus, and shrinks back to the button whenever
 * it is empty and unfocused -- whether the user blurred it or a control
 * elsewhere cleared the value while it was not focused. A controlled input
 * (value / onChange / onClear)
 * like `SearchField`, so callers keep owning the query; the expand/collapse is
 * internal, ephemeral UI state.
 *
 * One always-mounted pill DOM whose width animates (CSS transition) between the
 * control height (collapsed circle) and `--sk-xsearch-w` (expanded); the input
 * fades in alongside. The magnifier stays a fixed square on the left so it never
 * jumps between the two states. Supports the same `glass` refraction treatment
 * as `Button`. Generic -- no product knowledge. See components.md.
 *
 * Per the i18n rule, the accessible names (label, clearLabel) are passed in
 * (translated by the caller); the English defaults are developer fallbacks.
 */
import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cx, useGlassRefraction } from '../../lib';
import { isSearchEmpty } from './isSearchEmpty';
import './ExpandingSearch.scss';

export interface ExpandingSearchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Called when the clear button is pressed. */
  readonly onClear?: () => void;
  /** Accessible name for the clear button. */
  readonly clearLabel?: string;
  /** Accessible name for the collapsed button and the expanded input. */
  readonly label?: string;
  /** Overlay the refractive glass-surface treatment (as on `Button`). */
  readonly glass?: boolean;
  /** Start expanded (e.g. for a Storybook state). Defaults to collapsed. */
  readonly defaultExpanded?: boolean;
}

export function ExpandingSearch({
  value,
  onClear,
  clearLabel = 'Clear',
  label = 'Search',
  glass = false,
  defaultExpanded = false,
  placeholder,
  className,
  ...rest
}: ExpandingSearchProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasValue = !isSearchEmpty(value);

  // A gentle rim refraction, matching the glass buttons.
  useGlassRefraction(rootRef, { enabled: glass, depth: 6, strength: 30 });

  // Moving focus into the input is what "opens" the field; do it whenever we
  // transition to expanded (from a click, a keyboard focus, or Escape's revert).
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  // Collapse when the value is emptied from the OUTSIDE while unfocused -- e.g.
  // a "show all" / "reset filters" control elsewhere clears the query. `onBlur`
  // never fires in that case (focus is already elsewhere), so watch the value:
  // if it goes empty and focus is not within the field, shrink back. Runs after
  // the focus effect above, so a just-expanded (focused) field is never caught.
  useEffect(() => {
    if (!expanded || !isSearchEmpty(value)) return;
    const root = rootRef.current;
    if (root !== null && !root.contains(document.activeElement)) setExpanded(false);
  }, [expanded, value]);

  const expand = (): void => setExpanded(true);

  // Collapse only when focus leaves the whole component AND the field is empty
  // (a non-empty search stays open). `relatedTarget` is null when focus goes to
  // nothing (e.g. a click on empty space), which correctly reads as "left".
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
    if (isSearchEmpty(value)) setExpanded(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Escape on an empty field collapses (via the blur path); a non-empty field
    // keeps its text (the caller owns clearing).
    if (e.key === 'Escape' && isSearchEmpty(value)) inputRef.current?.blur();
  };

  return (
    <div
      ref={rootRef}
      className={cx('sk-xsearch', expanded && 'sk-xsearch--expanded', glass && 'sk-xsearch--glass', className)}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className="sk-xsearch__icon"
        aria-label={label}
        aria-expanded={expanded}
        tabIndex={expanded ? -1 : 0}
        // Keep the input's focus on pointer interaction; `onClick` drives the
        // expand and the effect moves focus into the input.
        onMouseDown={(e) => e.preventDefault()}
        onClick={expand}
        onFocus={expand}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="10.5"
            y1="10.5"
            x2="14"
            y2="14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="search"
        className="sk-xsearch__input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-hidden={!expanded}
        tabIndex={expanded ? 0 : -1}
        onKeyDown={handleInputKeyDown}
        {...rest}
      />
      {expanded && hasValue && onClear !== undefined && (
        <button
          type="button"
          className="sk-xsearch__clear"
          aria-label={clearLabel}
          // Clearing keeps focus in the input so the field stays open.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClear();
            inputRef.current?.focus();
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="8" fill="currentColor" />
            <path
              d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
              stroke="var(--sk-color-bg-tertiary)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
