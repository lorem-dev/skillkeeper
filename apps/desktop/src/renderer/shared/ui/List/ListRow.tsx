/**
 * List row: leading / content (title + subtitle) / trailing slots. Renders as a
 * button when `onClick` is given, otherwise a static row. Generic -- no product
 * knowledge. See design-system.md Section 8.5.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './ListRow.scss';

export interface ListRowProps {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  /** Free-form content rendered after title/subtitle. */
  readonly children?: ReactNode;
  /** When set, the row becomes an interactive button. */
  readonly onClick?: () => void;
  readonly selected?: boolean;
  readonly className?: string;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  children,
  onClick,
  selected,
  className,
}: ListRowProps) {
  const interactive = onClick !== undefined;
  const cls = cx(
    'sk-list-row',
    interactive && 'sk-list-row--interactive',
    selected === true && 'sk-list-row--selected',
    className,
  );

  const inner = (
    <>
      {leading !== undefined && <span className="sk-list-row__leading">{leading}</span>}
      <span className="sk-list-row__content">
        {title !== undefined && <span className="sk-list-row__title">{title}</span>}
        {subtitle !== undefined && <span className="sk-list-row__subtitle">{subtitle}</span>}
        {children}
      </span>
      {trailing !== undefined && <span className="sk-list-row__trailing">{trailing}</span>}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        role="listitem"
        className={cls}
        onClick={onClick}
        aria-current={selected === true ? true : undefined}
      >
        {inner}
      </button>
    );
  }

  return (
    <div role="listitem" className={cls}>
      {inner}
    </div>
  );
}
