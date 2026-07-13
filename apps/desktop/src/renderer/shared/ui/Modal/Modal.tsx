/**
 * Modal dialog. Renders into a portal over a dimmed scrim, animated with Framer
 * Motion presence (scrim fades, dialog fades + scales in). Closes on Escape or
 * scrim click. A solid elevated surface (no backdrop refraction) so the
 * entrance never flickers. Generic -- no product knowledge. See 8.9.
 *
 * Sizing & scroll: the dialog is always exactly as tall as its content -- it is
 * never capped or given an inner scroll region. Instead the scroll lives on the
 * WINDOW around it (`.sk-modal__viewport`, the scroll container filling the
 * scrim): a short dialog centers with a margin on every side; a tall one flows
 * to its full content height and the whole block scrolls within that window, as
 * one unit, keeping its margins (including the bottom).
 *
 * Edge fades: the scrim is stationary and hosts the fade blocks, so they stay
 * pinned to the window's top/bottom edges while the dialog scrolls under them.
 * A block appears only on the edge that still has hidden content -- a gradient
 * that dissolves the leaving content into the dark surroundings -- and none
 * shows when the dialog fits without scrolling (sized from the window's scroll
 * position in the effect below).
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, fade, fadeScale } from '../../lib';
import './Modal.scss';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

// Height of a top/bottom fade block when that edge has hidden content.
const FADE_PX = 48;
// Sub-pixel scroll positions are common (fractional zoom, high-DPI); treat
// anything under this as "at the edge" rather than "still scrollable".
const EDGE_EPSILON_PX = 1;

/**
 * Reads the scroll window's position and sizes the fade custom properties so a
 * block appears only on the edge that has hidden content: none at the very top,
 * none at the very bottom, and none at all when the dialog fits without
 * scrolling. The blocks live on `scrim` (stationary), so they read the
 * properties there even though the scroll happens on `viewport`.
 */
function updateFades(viewport: HTMLDivElement, scrim: HTMLDivElement): void {
  const { scrollTop, scrollHeight, clientHeight } = viewport;
  const overflows = scrollHeight - clientHeight > EDGE_EPSILON_PX;
  const hasHiddenTop = overflows && scrollTop > EDGE_EPSILON_PX;
  const hasHiddenBottom = overflows && scrollTop < scrollHeight - clientHeight - EDGE_EPSILON_PX;
  scrim.style.setProperty('--sk-modal-fade-top', hasHiddenTop ? `${FADE_PX}px` : '0px');
  scrim.style.setProperty('--sk-modal-fade-bottom', hasHiddenBottom ? `${FADE_PX}px` : '0px');
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Recompute the fades on window scroll, on viewport resize, and whenever the
  // dialog's own size changes (a field growing, a validation message appearing)
  // -- all of which can change whether content is hidden above or below.
  useEffect(() => {
    if (!open) return undefined;
    const viewport = viewportRef.current;
    const scrim = scrimRef.current;
    if (viewport === null || scrim === null) return undefined;

    const recompute = (): void => updateFades(viewport, scrim);
    recompute();

    viewport.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);

    const observer = new ResizeObserver(recompute);
    observer.observe(viewport);
    if (dialogRef.current !== null) observer.observe(dialogRef.current);

    return () => {
      viewport.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
      observer.disconnect();
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={scrimRef}
          className="sk-modal__scrim"
          variants={fade}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={onClose}
        >
          <div className="sk-modal__viewport" ref={viewportRef}>
            <div className="sk-modal__center">
              <motion.div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                className={cx('sk-modal', className)}
                variants={fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
                onClick={(e) => e.stopPropagation()}
              >
                {title !== undefined && <div className="sk-modal__title">{title}</div>}
                <div className="sk-modal__body">{children}</div>
              </motion.div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
