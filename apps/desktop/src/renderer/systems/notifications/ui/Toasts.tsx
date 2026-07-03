/**
 * Bottom-right danger toasts, one per store `toasts` entry. Clicking a toast
 * dismisses it. Cross-cutting UI -> lives in systems/notifications.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Alert } from '@/shared/ui';
import './Toasts.scss';

export function Toasts() {
  const toasts = useSkillkeeperStore((s) => s.toasts);
  const dismissToast = useSkillkeeperStore((s) => s.dismissToast);
  const t = useTranslator();
  return (
    <div className="sk-toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className="sk-toasts__item"
            role="button"
            tabIndex={0}
            onClick={() => dismissToast(toast.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') dismissToast(toast.id);
            }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            <Alert tone="danger" title={t('notifications.error')}>
              {toast.message}
            </Alert>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
