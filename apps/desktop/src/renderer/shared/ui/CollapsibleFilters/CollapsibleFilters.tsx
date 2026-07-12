/**
 * A page's filter row that expands/collapses with a height + fade animation,
 * toggled by a `FilterButton`. Wraps the filter controls and takes the page's
 * own filter-row class (so it keeps that row's flex layout and spacing).
 *
 * `overflow` is driven through the motion targets, not React state, so there is
 * no race with the animation: it is `hidden` for the whole enter/exit (the
 * growing/shrinking content is masked to the animated height, so the collapse
 * reads as a smooth wipe) and flips to `visible` only via `transitionEnd` once
 * fully open -- otherwise the controls' focus rings would clip at the row edges.
 * `MultiCombobox` dropdowns portal to the body, so they are never clipped.
 *
 * The row's top spacing lives in its own class as `padding-top` (not the
 * header's flex `gap`), so it is part of the animated height and there is no
 * instant jump when the row appears.
 */
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cx } from '../../lib';

export interface CollapsibleFiltersProps {
  /** Whether the row is shown. */
  readonly open: boolean;
  /** The page's filter-row class (flex layout + spacing). */
  readonly className?: string;
  /** Notified when focus enters/leaves the row -- lets the toggle keep the row
   *  open while a filter control inside it is focused. */
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
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="filters"
          className={cx(className)}
          initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
          animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
          exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
          // React's onFocus/onBlur bubble (focusin/focusout), so these fire for
          // any control in the row; `relatedTarget` outside the row means focus
          // actually left it.
          onFocus={() => onFocusWithinChange?.(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              onFocusWithinChange?.(false);
            }
          }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
