/**
 * Tooltip: a small label shown on hover/focus of its trigger, animated with
 * Framer Motion presence. The bubble is rendered in a portal and positioned
 * `fixed`, so it is never clipped by an ancestor's overflow (scroll areas, the
 * sidebar, etc.). Positioned on one of four sides; `auto` (the default) measures
 * the room around the trigger and picks a side that fits, then clamps the bubble
 * so it stays inside the window. Generic -- no product knowledge.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './Tooltip.scss';

/** Concrete sides. `auto` resolves to one of these at open time. */
type Side = 'top' | 'bottom' | 'left' | 'right';
export type TooltipPlacement = Side | 'auto';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  /** Side to render on. `auto` (default) picks a side that fits the window. */
  readonly placement?: TooltipPlacement;
  /**
   * For top/bottom placements, whether the bubble centers on the trigger
   * (default) or aligns to its start (left) edge -- useful for a wide trigger
   * like a full-width link, so the bubble sits over the start, not the middle.
   */
  readonly align?: 'center' | 'start';
  /**
   * When true, the trigger renders without a tooltip. Use it to suppress the
   * bubble while an overlay it belongs to is open (e.g. a SplitButton menu),
   * so the tooltip does not cover that overlay.
   */
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Gap between trigger and bubble. */
const GAP = 6;
/** Minimum gap kept between the bubble and the window edge. */
const EDGE_MARGIN = 8;
/** Side preference for `auto` when several fit. */
const AUTO_ORDER: readonly Side[] = ['top', 'bottom', 'right', 'left'];

// Reveal is opacity + scale only; the directional feel comes from the
// per-placement transform-origin in CSS, so the animation never fights the
// positional (fixed top/left) placement.
const bubble = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Room (px) between the trigger rect and each window edge. */
function roomOn(side: Side, trigger: DOMRect): number {
  switch (side) {
    case 'top':
      return trigger.top;
    case 'bottom':
      return window.innerHeight - trigger.bottom;
    case 'left':
      return trigger.left;
    case 'right':
      return window.innerWidth - trigger.right;
  }
}

/** First side (by preference) with room for the bubble; else the first choice. */
function pickSide(trigger: DOMRect, w: number, h: number): Side {
  const fits = (side: Side): boolean => {
    const extent = side === 'top' || side === 'bottom' ? h : w;
    return roomOn(side, trigger) >= extent + GAP + EDGE_MARGIN;
  };
  return AUTO_ORDER.find(fits) ?? 'top';
}

export function Tooltip({
  content,
  children,
  placement = 'auto',
  align = 'center',
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  // Suppress the bubble when disabled, even if the trigger is still hovered.
  const show = open && !disabled;
  const [side, setSide] = useState<Side>(placement === 'auto' ? 'top' : placement);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Resolve the side (for `auto`) and the window-clamped fixed position once the
  // bubble is in the DOM. offsetWidth/Height ignore the scale reveal transform.
  const reposition = useCallback(() => {
    const root = rootRef.current;
    const el = bubbleRef.current;
    if (root === null || el === null) return;

    const trigger = root.getBoundingClientRect();
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    const resolved = placement === 'auto' ? pickSide(trigger, bw, bh) : placement;

    let top: number;
    let left: number;
    if (resolved === 'top' || resolved === 'bottom') {
      top = resolved === 'top' ? trigger.top - GAP - bh : trigger.bottom + GAP;
      left = align === 'start' ? trigger.left : trigger.left + (trigger.width - bw) / 2;
    } else {
      left = resolved === 'left' ? trigger.left - GAP - bw : trigger.right + GAP;
      top = trigger.top + (trigger.height - bh) / 2;
    }
    left = clamp(left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - bw);
    top = clamp(top, EDGE_MARGIN, window.innerHeight - EDGE_MARGIN - bh);

    setSide(resolved);
    setPos({ top, left });
  }, [placement, align]);

  useLayoutEffect(() => {
    if (!show) {
      setPos(null);
      return undefined;
    }
    reposition();
    // Keep the bubble anchored if the page scrolls or the window resizes while
    // it is open (capture phase catches scrolls in nested containers).
    const onChange = (): void => reposition();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [show, reposition]);

  return (
    <span
      ref={rootRef}
      className={cx('sk-tooltip', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={show ? id : undefined}>{children}</span>
      {createPortal(
        <AnimatePresence>
          {show && (
            <motion.span
              ref={bubbleRef}
              role="tooltip"
              id={id}
              className="sk-tooltip__bubble"
              data-placement={side}
              // Kept offscreen for the first (pre-measurement) frame so it never
              // flashes at 0,0; the layout effect positions it before paint.
              style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
              variants={bubble}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {content}
            </motion.span>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}
