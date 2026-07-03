/**
 * Full-screen error-log overlay. Lists every errorLog entry (newest first) with
 * per-entry and copy-all clipboard actions and a clear-log action. Open state
 * lives in the store (logsOpen); Escape or the close button dismisses it.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import type { ErrorEntry } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon } from '@/shared/ui';
import { fade } from '@/shared/lib';
import './LogsPage.scss';

/** Serialize one entry for the clipboard: "<at> [<repoId>] <message>". */
function formatEntry(entry: ErrorEntry): string {
  const repo = entry.repoId !== undefined ? ` [${entry.repoId}]` : '';
  return `${entry.at}${repo} ${entry.message}`;
}

export function LogsPage() {
  const logsOpen = useSkillkeeperStore((s) => s.logsOpen);
  const errorLog = useSkillkeeperStore((s) => s.errorLog);
  const closeLogs = useSkillkeeperStore((s) => s.closeLogs);
  const clearErrorLog = useSkillkeeperStore((s) => s.clearErrorLog);
  const t = useTranslator();

  // Newest first, without mutating store state.
  const entries = [...errorLog].reverse();

  // Focus the overlay once when it opens (not on every re-render -- a background
  // notify() re-renders this component and must not yank focus back).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logsOpen) overlayRef.current?.focus();
  }, [logsOpen]);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') closeLogs();
  }

  return (
    <AnimatePresence>
      {logsOpen && (
        <motion.div
          className="sk-logs"
          role="dialog"
          aria-modal="true"
          aria-label={t('logs.title')}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          ref={overlayRef}
          variants={fade}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <header className="sk-logs__header">
            <h1 className="sk-logs__title">{t('logs.title')}</h1>
            <div className="sk-logs__actions">
              <Button
                variant="destructive"
                onClick={clearErrorLog}
                disabled={entries.length === 0}
              >
                {t('logs.clear')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => copy(entries.map(formatEntry).join('\n'))}
                disabled={entries.length === 0}
              >
                {t('logs.copyAll')}
              </Button>
              <Button
                variant="plain"
                className="sk-logs__close"
                onClick={closeLogs}
                aria-label={t('common.close')}
              >
                <Icon name="close" />
              </Button>
            </div>
          </header>

          {entries.length === 0 ? (
            <div className="sk-logs__empty">{t('logs.empty')}</div>
          ) : (
            <ul className="sk-logs__list">
              {entries.map((entry) => (
                <li key={entry.id} className="sk-logs__row">
                  <div className="sk-logs__meta">
                    <time className="sk-logs__time" dateTime={entry.at}>
                      {entry.at}
                    </time>
                    {entry.repoId !== undefined && (
                      <span className="sk-logs__repo">{entry.repoId}</span>
                    )}
                  </div>
                  <p className="sk-logs__message">{entry.message}</p>
                  <Button
                    variant="plain"
                    className="sk-logs__copy"
                    onClick={() => copy(formatEntry(entry))}
                    aria-label={t('logs.copy')}
                  >
                    <Icon name="copy" size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
