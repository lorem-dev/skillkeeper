/**
 * Makes the SSH passphrase prompt modal to the app: while it is up, this window
 * takes no interaction at all, and says why.
 *
 * Three layers, because no single one of them blocks everything:
 *
 * - `inert` on the app root removes the whole tree from hit-testing, from the
 *   focus order and from the accessibility tree, so nothing behind the block can
 *   be clicked, tabbed into, or reached by a screen reader (and whatever had the
 *   focus loses it, per the spec).
 * - A full-window scrim above every overlay -- portaled popovers and tooltips
 *   included, which mount to `document.body` and are therefore outside the
 *   inert root. It is also what makes the block visible rather than looking like
 *   the app has hung.
 * - A capture-phase `keydown` swallow, for the shortcuts that listen on `window`
 *   rather than on an element (Escape-to-close and friends): `inert` does not
 *   stop those, since they never needed a focused element to begin with.
 *
 * Nothing here calls `preventDefault`, so the window's own accelerators (close,
 * minimize, the application menu) keep working -- the app is blocked, not the
 * window manager.
 *
 * NOT done at the window-manager level, on purpose: Tauri's `set_enabled(false)`
 * blocks input properly on Windows and Linux, but on macOS it attaches a
 * translucent sheet to the window -- and since the prompt is a child of this
 * window, that sheet covered and disabled the passphrase dialog itself.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { fade } from '@/shared/lib';
import { useTranslator } from '@/systems/i18n';
import { useUnlockPromptOpen } from '../model/useUnlockPrompt';
import './SshUnlockBlocker.scss';

/** The app's React root (see `main.tsx`); the scrim portals outside it. */
const APP_ROOT_ID = 'root';

export function SshUnlockBlocker() {
  const t = useTranslator();
  const open = useUnlockPromptOpen();

  useEffect(() => {
    if (!open) return undefined;
    const root = document.getElementById(APP_ROOT_ID);
    root?.setAttribute('inert', '');
    const swallow = (e: KeyboardEvent): void => {
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => {
      root?.removeAttribute('inert');
      window.removeEventListener('keydown', swallow, true);
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="sk-ssh-block" variants={fade} initial="initial" animate="animate" exit="exit">
          <p className="sk-ssh-block__note" role="status">
            {t('ssh.unlock.blocking')}
          </p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
