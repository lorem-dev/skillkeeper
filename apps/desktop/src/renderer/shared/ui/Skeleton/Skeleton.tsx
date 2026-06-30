/**
 * Skeleton placeholder with a shimmer, for loading states. Generic -- no product
 * knowledge. Decorative: hidden from assistive tech.
 */
import { cx } from '../../lib';
import './Skeleton.scss';

export interface SkeletonProps {
  readonly width?: string | number;
  readonly height?: string | number;
  /** Override border-radius (defaults to --sk-radius-sm). */
  readonly radius?: string;
  readonly className?: string;
}

export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  return (
    <span
      className={cx('sk-skeleton', className)}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}
