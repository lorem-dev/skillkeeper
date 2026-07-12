/**
 * Filter toggle: a round glass icon button (a funnel) that shows/hides a page's
 * filter row, carrying a small count badge of how many filters are active.
 *
 * Interaction (driven by `count`, the number of non-empty filters):
 *   - count === 0: the button toggles the (empty) filter row open/closed.
 *   - count > 0:   the badge shows the count and clicking clears the filters
 *                  (which collapses the row). The tooltip switches to the
 *                  "clear" wording in that state.
 * Presentational -- the page owns the filter values, the open flag, and the
 * clear/toggle handlers; this component only renders the button + badge and
 * routes the click to the right handler. Generic -- no product knowledge.
 */
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Tooltip } from '../Tooltip';
import './FilterButton.scss';

export interface FilterButtonProps {
  /** Number of non-empty filters; the badge shows when this is > 0. */
  readonly count: number;
  /** Whether the filter row is currently open (for `aria-expanded`). */
  readonly open: boolean;
  /** Toggle the (empty) filter row -- used when `count === 0`. */
  readonly onToggle: () => void;
  /** Clear all filters (collapsing the row) -- used when `count > 0`. */
  readonly onClear: () => void;
  /** Tooltip/label when no filters are active (a plain toggle). */
  readonly filterLabel: string;
  /** Tooltip/label when filters are active (clicking clears them). */
  readonly clearLabel: string;
}

export function FilterButton({
  count,
  open,
  onToggle,
  onClear,
  filterLabel,
  clearLabel,
}: FilterButtonProps) {
  const active = count > 0;
  const label = active ? clearLabel : filterLabel;
  return (
    <Tooltip content={label}>
      <span className="sk-filter-btn">
        <Button
          variant="secondary"
          glass
          className="sk-filter-btn__button"
          aria-label={label}
          aria-expanded={open || active}
          onClick={active ? onClear : onToggle}
        >
          <Icon name="filter" size={16} />
        </Button>
        {active && (
          <span className="sk-filter-btn__badge" aria-hidden="true">
            {count}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
