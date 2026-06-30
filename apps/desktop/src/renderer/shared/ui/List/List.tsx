/**
 * Grouped list container: a rounded surface with hairline separators between
 * rows. Compose with ListRow. Generic -- no product knowledge.
 * See design-system.md Section 8.5.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './List.scss';

export interface ListProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function List({ children, className }: ListProps) {
  return (
    <div role="list" className={cx('sk-list', className)}>
      {children}
    </div>
  );
}
