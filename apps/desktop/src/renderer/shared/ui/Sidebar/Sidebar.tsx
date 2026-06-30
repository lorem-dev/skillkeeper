/**
 * Sidebar: the leading-edge navigation surface (a glass panel). Compose with
 * SidebarItem. Generic -- no product knowledge. See design-system.md Section 8.6.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Sidebar.scss';

export interface SidebarProps {
  /** Optional header shown above the items. */
  readonly title?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Sidebar({ title, children, className }: SidebarProps) {
  return (
    <nav className={cx('sk-sidebar', className)}>
      {title !== undefined && <div className="sk-sidebar__title">{title}</div>}
      <div className="sk-sidebar__items">{children}</div>
    </nav>
  );
}
