/**
 * Table: a borderless, macOS-list-style data table matching the TreeView look
 * (no cell borders, muted header, hover rows). Columns share a CSS grid track
 * template so the header and every row align. With `stickyHeader` + a
 * `maxBodyHeight`, the header stays put while the body scrolls. Generic -- no
 * product knowledge; cells and headers are ReactNodes.
 */
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib';
import './Table.scss';

export interface TableColumn {
  readonly key: string;
  readonly header: ReactNode;
  /** CSS grid track size (e.g. '1fr', '8rem', '30%'). Defaults to '1fr'. */
  readonly width?: string;
  readonly align?: 'start' | 'end';
}

export interface TableRow {
  readonly id: string;
  /** Cells, index-aligned to `columns`. */
  readonly cells: readonly ReactNode[];
}

export interface TableProps {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  /** Fix the header and scroll the body (needs `maxBodyHeight`). */
  readonly stickyHeader?: boolean;
  /** Max body height (CSS length) past which the body scrolls. */
  readonly maxBodyHeight?: string;
  readonly ariaLabel?: string;
  readonly emptyText?: ReactNode;
  readonly className?: string;
}

export function Table({
  columns,
  rows,
  stickyHeader = false,
  maxBodyHeight,
  ariaLabel,
  emptyText,
  className,
}: TableProps) {
  const template = columns.map((c) => c.width ?? '1fr').join(' ');
  const style = { '--sk-table-cols': template } as CSSProperties;
  const bodyStyle: CSSProperties | undefined =
    stickyHeader && maxBodyHeight !== undefined
      ? { maxHeight: maxBodyHeight, overflowY: 'auto' }
      : undefined;

  return (
    <div
      className={cx('sk-table', stickyHeader && 'sk-table--sticky', className)}
      role="table"
      aria-label={ariaLabel}
      style={style}
    >
      <div className="sk-table__head" role="row">
        {columns.map((col) => (
          <div
            key={col.key}
            role="columnheader"
            className={cx('sk-table__cell', 'sk-table__th', col.align === 'end' && 'sk-table__cell--end')}
          >
            {col.header}
          </div>
        ))}
      </div>
      <div className="sk-table__body" style={bodyStyle}>
        {rows.length === 0 && emptyText !== undefined ? (
          <div className="sk-table__empty">{emptyText}</div>
        ) : (
          rows.map((row) => (
            <div key={row.id} role="row" className="sk-table__row">
              {row.cells.map((cell, i) => (
                <div
                  key={columns[i]?.key ?? String(i)}
                  role="cell"
                  className={cx('sk-table__cell', columns[i]?.align === 'end' && 'sk-table__cell--end')}
                >
                  {cell}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
