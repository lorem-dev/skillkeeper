/**
 * Modal dialog. Renders into a portal over a dimmed scrim, animated with Framer
 * Motion presence (scrim fades, dialog fades + scales in). Closes on Escape or
 * scrim click. A solid elevated surface (no backdrop refraction) so the
 * entrance never flickers. Generic -- no product knowledge. See 8.9.
 *
 * The scrim is the scroll container, not the dialog body: a dialog taller
 * than the viewport is not clipped or capped, it simply flows to its full
 * content height and the whole block scrolls within the scrim (see
 * Modal.scss for the centering technique). Whichever edge still has hidden
 * content gets a soft mask fade, computed from the scrim's own scroll
 * position in the effect below.
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

// Width of the top/bottom edge-fade band. A fixed pixel size reads
// consistently regardless of how tall the dialog gets.
const EDGE_FADE_PX = 48;
// Sub-pixel scroll positions are common (fractional zoom, high-DPI); treat
// anything under this as "at the edge" rather than "still scrollable".
const EDGE_EPSILON_PX = 1;

/**
 * Reads the scrim's scroll position and toggles its edge-fade custom
 * properties so the fade appears only on the edge that has hidden content:
 * no top fade at the very top, no bottom fade at the very bottom, and no
 * fade at all when the dialog fits without scrolling.
 */
function updateEdgeFade(scrim: HTMLDivElement): void {
  const { scrollTop, scrollHeight, clientHeight } = scrim;
  const overflows = scrollHeight - clientHeight > EDGE_EPSILON_PX;
  const hasHiddenTop = overflows && scrollTop > EDGE_EPSILON_PX;
  const hasHiddenBottom = overflows && scrollTop < scrollHeight - clientHeight - EDGE_EPSILON_PX;
  scrim.style.setProperty('--sk-modal-fade-top', hasHiddenTop ? `${EDGE_FADE_PX}px` : '0px');
  scrim.style.setProperty('--sk-modal-fade-bottom', hasHiddenBottom ? `${EDGE_FADE_PX}px` : '0px');
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Recompute the edge fade on scroll, on viewport resize, and whenever the
  // dialog's own size changes (a field growing, a validation message
  // appearing) -- all of which can change whether content is hidden above or
  // below the visible band.
  useEffect(() => {
    if (!open) return undefined;
    const scrim = scrimRef.current;
    if (scrim === null) return undefined;

    const recompute = (): void => updateEdgeFade(scrim);
    recompute();

    scrim.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);

    const observer = new ResizeObserver(recompute);
    observer.observe(scrim);
    if (dialogRef.current !== null) observer.observe(dialogRef.current);

    return () => {
      scrim.removeEventListener('scroll', recompute);
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
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
