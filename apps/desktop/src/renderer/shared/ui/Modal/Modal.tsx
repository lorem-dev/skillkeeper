/**
 * Modal dialog. Renders into a portal over a dimmed scrim, animated with Framer
 * Motion presence (scrim fades, dialog rises). Closes on Escape or scrim click.
 * Generic -- no product knowledge. See design-system.md Section 8.9.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cx, fade, fadeRise, useGlassRefraction } from '../../lib';
import './Modal.scss';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Refract the backdrop while the dialog is open (re-applies when it opens).
  useGlassRefraction(ref, { enabled: open, radius: 26, strength: 50, chromaticAberration: 2 });

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="sk-modal__scrim"
          variants={fade}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={onClose}
        >
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            className={cx('sk-modal', className)}
            variants={fadeRise}
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
