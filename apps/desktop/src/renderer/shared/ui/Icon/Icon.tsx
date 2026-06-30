/**
 * Icon: renders a named line icon as inline SVG. Generic -- no product knowledge.
 *
 * Icons are stroke-based on a 24x24 grid and use `currentColor`, so they inherit
 * the surrounding text color and size via the `size` prop. Decorative by default
 * (hidden from assistive tech); pass `label` to expose an accessible name.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';

export type IconName =
  | 'repositories'
  | 'skills'
  | 'projects'
  | 'settings'
  | 'search'
  | 'plus'
  | 'check'
  | 'chevron-right';

const ICONS: Record<IconName, ReactNode> = {
  repositories: (
    <path d="M4 7a2 2 0 0 1 2-2h3.5l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
  ),
  skills: <path d="M12 4l1.7 4.6 4.8 1.4-4.8 1.4L12 16l-1.7-4.6L5.5 10l4.8-1.4z" />,
  projects: (
    <>
      <rect x="3.5" y="8" width="17" height="11" rx="2" />
      <path d="M8.5 8V6.5A1.5 1.5 0 0 1 10 5h4a1.5 1.5 0 0 1 1.5 1.5V8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.4 M12 18.6V21 M21 12h-2.4 M5.4 12H3 M18.4 5.6l-1.7 1.7 M7.3 16.7l-1.7 1.7 M18.4 18.4l-1.7-1.7 M7.3 7.3 5.6 5.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  plus: <path d="M12 5v14 M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 6.5" />,
  'chevron-right': <path d="M9.5 6l6 6-6 6" />,
};

export interface IconProps {
  readonly name: IconName;
  /** Pixel size (width and height). Defaults to 20. */
  readonly size?: number;
  /** Accessible name. When omitted the icon is decorative (hidden from AT). */
  readonly label?: string;
  readonly className?: string;
}

export function Icon({ name, size = 20, label, className }: IconProps) {
  return (
    <svg
      className={cx('sk-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? 'presentation' : 'img'}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      {ICONS[name]}
    </svg>
  );
}
