/**
 * Alert: an inline message surface with a tone. Animates its height/opacity via
 * Framer Motion, so wrapping it in <AnimatePresence> gives a smooth
 * collapse on dismiss. Generic -- no product knowledge.
 */
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx, collapse, useGlassRefraction } from '../../lib';
import './Alert.scss';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Frosted glass behind the tone tint (subtle, since alerts often sit on a flat
  // surface where the tint carries the look).
  useGlassRefraction(ref, { radius: 16, depth: 6, strength: 30, chromaticAberration: 1 });
  return (
    <motion.div
      ref={ref}
      role="alert"
      className={cx('sk-alert', `sk-alert--${tone}`, className)}
      variants={collapse}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="sk-alert__body">
        {title !== undefined && <strong className="sk-alert__title">{title}</strong>}
        {children !== undefined && <div className="sk-alert__content">{children}</div>}
      </div>
    </motion.div>
  );
}
