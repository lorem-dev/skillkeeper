/**
 * Tooltip: a small label shown on hover/focus of its trigger, animated with
 * Framer Motion presence. Generic -- no product knowledge.
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './Tooltip.scss';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

// Centering uses x:'-50%' inside the motion transform so it composes with scale.
const bubble = {
  initial: { opacity: 0, scale: 0.96, x: '-50%' },
  animate: {
    opacity: 1,
    scale: 1,
    x: '-50%',
    transition: { duration: SK_DURATION.fast, ease: SK_EASE },
  },
  exit: { opacity: 0, scale: 0.96, x: '-50%', transition: { duration: SK_DURATION.fast } },
};

export function Tooltip({ content, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className={cx('sk-tooltip', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <AnimatePresence>
        {open && (
          <motion.span
            role="tooltip"
            id={id}
            className="sk-tooltip__bubble"
            variants={bubble}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
