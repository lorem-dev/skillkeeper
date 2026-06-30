/**
 * Card: a rounded surface for grouping content. Optional glass variant.
 * Generic -- no product knowledge. See design-system.md Section 4 / 5.
 */
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { cx, useGlassRefraction } from '../../lib';
import './Card.scss';

export interface CardProps {
  readonly children: ReactNode;
  /** Use a translucent glass surface instead of the solid one. */
  readonly glass?: boolean;
  readonly className?: string;
}

export function Card({ children, glass, className }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Refract the backdrop when the glass variant is on; no-op otherwise.
  useGlassRefraction(ref, { enabled: glass === true });
  return (
    <div ref={ref} className={cx('sk-card', glass === true && 'sk-card--glass', className)}>
      {children}
    </div>
  );
}
