/**
 * A page's filter row that expands/collapses jump-free using the CSS
 * `grid-template-rows: 0fr -> 1fr` technique: no height measurement, so there is
 * no snap at the end of the animation (framer's `height: 'auto'` measures and
 * snaps -- mirrors DisclosureGroup instead). The inner element clips its
 * overflow and can shrink to zero; the page's own filter-row class (flex layout
 * + top spacing) goes on the body inside it.
 *
 * Collapsed, the row is `inert` so its controls are not focusable/interactive.
 * `MultiCombobox` focus is a border (not an outline ring) and its dropdown
 * portals to the body, so the permanent `overflow: hidden` clips neither.
 *
 * `onFocusWithinChange` (React's onFocus/onBlur bubble) lets the toggle keep the
 * row open while a filter control inside it is focused.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './CollapsibleFilters.scss';

export interface CollapsibleFiltersProps {
  /** Whether the row is shown. */
  readonly open: boolean;
  /** The page's filter-row class (flex layout + spacing). */
  readonly className?: string;
  /** Notified when focus enters/leaves the row. */
  readonly onFocusWithinChange?: (focused: boolean) => void;
  readonly children: ReactNode;
}

export function CollapsibleFilters({
  open,
  className,
  onFocusWithinChange,
  children,
}: CollapsibleFiltersProps) {
  return (
    <div
      className={cx('sk-collapsible-filters', open && 'sk-collapsible-filters--open')}
      inert={!open}
      onFocus={() => onFocusWithinChange?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          onFocusWithinChange?.(false);
        }
      }}
    >
      <div className="sk-collapsible-filters__inner">
        <div className={cx(className)}>{children}</div>
      </div>
    </div>
  );
}
