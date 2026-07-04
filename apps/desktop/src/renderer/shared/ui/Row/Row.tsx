/**
 * Row: a horizontal flex layout primitive. Arranges its children in a row with a
 * token-based gap and configurable alignment/justification. Generic -- no
 * product knowledge. Pair with the vertical rhythm of Page/FormSection.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Row.scss';

export interface RowProps {
  /** Cross-axis alignment. Defaults to `center`. */
  readonly align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  /** Main-axis distribution. Defaults to `start`. */
  readonly justify?: 'start' | 'center' | 'end' | 'between';
  /** Gap between children, as a `--sk-space-N` step (1-8). */
  readonly gap?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Allow children to wrap onto multiple lines. */
  readonly wrap?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Row({
  align = 'center',
  justify = 'start',
  gap,
  wrap = false,
  className,
  children,
}: RowProps) {
  return (
    <div
      className={cx(
        'sk-row',
        `sk-row--align-${align}`,
        `sk-row--justify-${justify}`,
        gap !== undefined && `sk-row--gap-${gap}`,
        wrap && 'sk-row--wrap',
        className,
      )}
    >
      {children}
    </div>
  );
}
