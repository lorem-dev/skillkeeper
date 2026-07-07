/**
 * Table: a borderless, macOS-list-style data table matching the TreeView look
 * (no cell borders, muted header, hover rows). Columns share a CSS grid track
 * template so the header and every row align. With `stickyHeader` +
 * `maxBodyHeight`, the header sticks to the top of the scroll area (rows slide
 * under it, blurred) and a small blurred fade marks more content below.
 * Generic -- no product knowledge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Max height (CSS length) past which the content scrolls. */
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
  const scrolls = stickyHeader && maxBodyHeight !== undefined;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  const update = useCallback(() => {
    const el = viewportRef.current;
    if (el === null) return;
    setCanUp(el.scrollTop > 1);
    setCanDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    if (!scrolls) return undefined;
    update();
    const el = viewportRef.current;
    if (el === null) return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrolls, update, rows]);

  const head = (
    <div
      className={cx('sk-table__head', scrolls && canUp && 'sk-table__head--scrolled')}
      role="row"
    >
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
  );

  const body = (
    <div className="sk-table__body">
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
  );

  return (
    <div
      className={cx('sk-table', stickyHeader && 'sk-table--sticky', className)}
      role="table"
      aria-label={ariaLabel}
      style={style}
    >
      {scrolls ? (
        <div className="sk-table__scroll-outer">
          <div
            className="sk-table__viewport"
            ref={viewportRef}
            style={{ maxHeight: maxBodyHeight, overflowY: 'auto' }}
            onScroll={update}
          >
            {head}
            {body}
          </div>
          <div
            className={cx('sk-table__fade', 'sk-table__fade--bottom', canDown && 'sk-table__fade--visible')}
            aria-hidden="true"
          />
        </div>
      ) : (
        <>
          {head}
          {body}
        </>
      )}
    </div>
  );
}
