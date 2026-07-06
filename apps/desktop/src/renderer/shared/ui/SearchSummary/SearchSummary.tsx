/**
 * Footer shown below a filtered card list while a search is active: a short
 * "found N of M" summary and a button that clears the search to show every
 * item again. Generic -- the caller supplies the (already translated,
 * plural-aware) summary text and button label.
 */
import { Button } from '../Button';
import './SearchSummary.scss';

export interface SearchSummaryProps {
  /** e.g. "Found 3 projects" (plural-aware; built by the caller). */
  readonly foundLabel: string;
  /** e.g. "12 projects total" (plural-aware; built by the caller). */
  readonly totalLabel: string;
  /** Label for the reset button, e.g. "Show all projects". */
  readonly showAllLabel: string;
  /** Clears the active search. */
  readonly onShowAll: () => void;
}

export function SearchSummary({ foundLabel, totalLabel, showAllLabel, onShowAll }: SearchSummaryProps) {
  return (
    <div className="sk-search-summary">
      <p className="sk-search-summary__counts">
        {foundLabel}. {totalLabel}.
      </p>
      <Button variant="secondary" onClick={onShowAll}>
        {showAllLabel}
      </Button>
    </div>
  );
}
