/**
 * Modal dialog. Renders into a portal over a dimmed scrim, animated with Framer
 * Motion presence (scrim fades, dialog fades + scales in). Closes on Escape or
 * scrim click. A solid elevated surface (no backdrop refraction) so the
 * entrance never flickers. Generic -- no product knowledge. See 8.9.
 *
 * A dialog taller than the viewport is not clipped or capped: it flows to
 * its full content height and the whole block scrolls, as one unit, within
 * an inner scroll viewport (see Modal.scss for the centering technique). The
 * scrim itself does NOT scroll -- it hosts the edge bars, which therefore
 * stay pinned to the visible top/bottom edges while the dialog slides under
 * them. Whichever edge still has hidden content gets a dark, blurred scrim
 * bar (the leaving content darkens and blurs into the dark surroundings),
 * sized from the viewport's scroll position in the effect below.
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

// Height of the top/bottom dark scrim band. A fixed pixel size reads
// consistently regardless of how tall the dialog gets.
const EDGE_SCRIM_PX = 48;
// Sub-pixel scroll positions are common (fractional zoom, high-DPI); treat
// anything under this as "at the edge" rather than "still scrollable".
const EDGE_EPSILON_PX = 1;

/**
 * Reads the viewport's scroll position and sizes the scrim's edge-scrim
 * custom properties so a bar appears only on the edge that has hidden
 * content: none at the very top, none at the very bottom, and none at all
 * when the dialog fits without scrolling. The bars live on `scrim` (the
 * stationary overlay), so they read the properties there even though the
 * scroll happens on `viewport`.
 */
function updateEdgeScrim(viewport: HTMLDivElement, scrim: HTMLDivElement): void {
  const { scrollTop, scrollHeight, clientHeight } = viewport;
  const overflows = scrollHeight - clientHeight > EDGE_EPSILON_PX;
  const hasHiddenTop = overflows && scrollTop > EDGE_EPSILON_PX;
  const hasHiddenBottom = overflows && scrollTop < scrollHeight - clientHeight - EDGE_EPSILON_PX;
  scrim.style.setProperty('--sk-modal-scrim-top', hasHiddenTop ? `${EDGE_SCRIM_PX}px` : '0px');
  scrim.style.setProperty('--sk-modal-scrim-bottom', hasHiddenBottom ? `${EDGE_SCRIM_PX}px` : '0px');
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

  // Recompute the edge scrim on scroll, on viewport resize, and whenever the
  // dialog's own size changes (a field growing, a validation message
  // appearing) -- all of which can change whether content is hidden above or
  // below the visible band.
  useEffect(() => {
    if (!open) return undefined;
    const viewport = viewportRef.current;
    const scrim = scrimRef.current;
    if (viewport === null || scrim === null) return undefined;

    const recompute = (): void => updateEdgeScrim(viewport, scrim);
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
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
