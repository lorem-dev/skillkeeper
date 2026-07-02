/**
 * Icon: renders a named line icon as inline SVG. Generic -- no product knowledge.
 *
 * Icons are stroke-based on a 24x24 grid and use `currentColor`, so they inherit
 * the surrounding text color and size via the `size` prop. Decorative by default
 * (hidden from assistive tech); pass `label` to expose an accessible name.
 *
 * Each icon's geometry lives in a standalone `./assets/<name>.svg` file, imported
 * as raw markup via Vite's built-in `?raw` suffix. The shared `<svg>` wrapper below
 * supplies the stroke/color/size/a11y attributes, so only the inner geometry is
 * taken from each asset -- its root `<svg>` is stripped once at module load.
 */
import { cx } from '../../lib';
import { stripSvgRoot } from './stripSvgRoot';
import repositories from './assets/repositories.svg?raw';
import skills from './assets/skills.svg?raw';
import projects from './assets/projects.svg?raw';
import settings from './assets/settings.svg?raw';
import search from './assets/search.svg?raw';
import plus from './assets/plus.svg?raw';
import check from './assets/check.svg?raw';
import chevronRight from './assets/chevron-right.svg?raw';

export type IconName =
  | 'repositories'
  | 'skills'
  | 'projects'
  | 'settings'
  | 'search'
  | 'plus'
  | 'check'
  | 'chevron-right';

const ICONS: Record<IconName, string> = {
  repositories: stripSvgRoot(repositories),
  skills: stripSvgRoot(skills),
  projects: stripSvgRoot(projects),
  settings: stripSvgRoot(settings),
  search: stripSvgRoot(search),
  plus: stripSvgRoot(plus),
  check: stripSvgRoot(check),
  'chevron-right': stripSvgRoot(chevronRight),
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
      // ICONS holds our own build-time ./assets/*.svg geometry, never user
      // input, so injecting it as markup is safe.
      // eslint-disable-next-line no-restricted-syntax -- trusted build-time icon asset
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
