/**
 * Bottom-right danger toasts, one per store `toasts` entry. Each toast
 * auto-dismisses after 5s and can also be dismissed by clicking it.
 * Cross-cutting UI -> lives in systems/notifications.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Alert } from '@/shared/ui';
import { fadeRise } from '@/shared/lib';
import './Toasts.scss';

/** How long a toast stays before it auto-dismisses (ms). */
const TOAST_TTL = 5000;

export function Toasts() {
  const toasts = useSkillkeeperStore((s) => s.toasts);
  const dismissToast = useSkillkeeperStore((s) => s.dismissToast);
  const t = useTranslator();

  // One stable auto-dismiss timer per toast. Timers live in a ref so a newly
  // added toast never resets an existing toast's countdown; gone toasts have
  // their timer cleared. (The motion.button stays a direct AnimatePresence child
  // so its exit animation runs -- hence timers are managed here, not in a wrapper.)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    for (const toast of toasts) {
      if (!timers.current.has(toast.id)) {
        timers.current.set(
          toast.id,
          setTimeout(() => dismissToast(toast.id), TOAST_TTL),
        );
      }
    }
    for (const [id, timer] of timers.current) {
      if (!toasts.some((toast) => toast.id === id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
  }, [toasts, dismissToast]);

  useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach(clearTimeout);
      active.clear();
    };
  }, []);

  return (
    <div className="sk-toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            type="button"
            className="sk-toasts__item"
            onClick={() => dismissToast(toast.id)}
            variants={fadeRise}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <Alert tone="danger" title={t('notifications.error')}>
              {toast.message}
            </Alert>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
