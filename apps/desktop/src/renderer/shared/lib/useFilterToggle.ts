/**
 * State for a `FilterButton` + `CollapsibleFilters` pair. Given the number of
 * active (non-empty) filters, tracks whether the filter row is shown.
 *
 * The row is visible when ANY of these hold:
 *   - a filter is active (`count > 0`);
 *   - the user toggled the empty row open;
 *   - focus is currently within the row.
 *
 * That last rule is what keeps the row from being yanked away while the user is
 * mid-interaction with a filter control: clearing the last selection drops the
 * count to zero, but the row stays until focus actually leaves it. When the
 * count is cleared from OUTSIDE the page while nothing in the row is focused
 * (e.g. a deep link or another control resets the filters), the row collapses
 * immediately. The manual-open flag is dropped as soon as real filters exist,
 * so visibility then tracks the count (and clearing hides the row).
 *
 * The page owns the actual filter values; this hook only owns the open/focus
 * flags. `onFocusWithinChange` is wired to `CollapsibleFilters`.
 */
import { useEffect, useState } from 'react';

export interface FilterToggle {
  /** Whether the user toggled the (empty) row open -- for `aria-expanded`. */
  readonly open: boolean;
  /** Whether the row should be shown. */
  readonly visible: boolean;
  /** Toggle the empty row open/closed (the `count === 0` action). */
  readonly toggle: () => void;
  /** Wire to `CollapsibleFilters.onFocusWithinChange`. */
  readonly onFocusWithinChange: (focused: boolean) => void;
}

export function useFilterToggle(count: number): FilterToggle {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);

  // Once real filters exist, drop the manual-open flag so visibility tracks the
  // count -- then clearing them (count back to 0, unfocused) collapses the row.
  useEffect(() => {
    if (count > 0) setOpen(false);
  }, [count]);

  return {
    open,
    visible: count > 0 || open || focused,
    toggle: () => setOpen((o) => !o),
    onFocusWithinChange: setFocused,
  };
}
