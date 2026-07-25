/**
 * Full-screen notifications log overlay. Lists notification entries (newest
 * first) with per-entry and copy-all clipboard actions, a level filter
 * (errors/warnings/messages; errors and warnings by default), and a clear
 * action. Open state lives in the store (logsOpen); Escape or the close button
 * dismisses it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import type { NotificationEntry, NotificationLevel } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon, MultiSelect } from '@/shared/ui';
import type { Translator } from '@/systems/i18n';
import { cx, dragRegion, fade } from '@/shared/lib';
import { resolveNotification } from '../resolveNotification';
import './LogsPage.scss';

/** The levels the filter can select, in display order. */
const LEVEL_ORDER: readonly NotificationLevel[] = ['error', 'warning', 'info'];

/** Narrow `MultiSelect`'s untyped `string[]` back to notification levels. */
function isLevel(value: string): value is NotificationLevel {
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

/** Serialize one entry for the clipboard: "<at> [<repoId>] <message>". */
function formatEntry(entry: NotificationEntry, t: Translator): string {
  const repo = entry.repoId !== undefined ? ` [${entry.repoId}]` : '';
  return `${entry.at}${repo} ${resolveNotification(entry, t)}`;
}

export function LogsPage() {
  const logsOpen = useSkillkeeperStore((s) => s.logsOpen);
  const notifications = useSkillkeeperStore((s) => s.notifications);
  const closeLogs = useSkillkeeperStore((s) => s.closeLogs);
  const clearNotifications = useSkillkeeperStore((s) => s.clearNotifications);
  const t = useTranslator();

  // Which levels to show. Errors and warnings by default: both are things the
  // user may need to act on. `info` is opt-in, being mostly per-operation noise.
  const [levels, setLevels] = useState<NotificationLevel[]>(['error', 'warning']);

  // Newest first, filtered by the selected levels; never mutates store state.
  const entries = useMemo(
    () => notifications.filter((n) => levels.includes(n.level)).reverse(),
    [notifications, levels],
  );

  const levelLabels: Record<NotificationLevel, string> = {
    error: t('logs.level.error'),
    warning: t('logs.level.warning'),
    info: t('logs.level.info'),
  };
  const levelOptions = LEVEL_ORDER.map((value) => ({ value, label: levelLabels[value] }));

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
          <header className="sk-logs__header" {...dragRegion({ always: true })}>
            <h1 className="sk-logs__title" {...dragRegion({ always: true })}>
              {t('logs.title')}
            </h1>
            <div className="sk-logs__actions">
              <MultiSelect
                options={levelOptions}
                value={levels}
                onChange={(next) => setLevels(next.filter(isLevel))}
                ariaLabel={t('logs.filter')}
                placeholder={t('logs.filter')}
              />
              <Button
                variant="destructive"
                onClick={clearNotifications}
                disabled={notifications.length === 0}
              >
                {t('logs.clear')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => copy(entries.map((e) => formatEntry(e, t)).join('\n'))}
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
                <li key={entry.id} className={cx('sk-logs__row', `sk-logs__row--${entry.level}`)}>
                  <div className="sk-logs__meta">
                    <time className="sk-logs__time" dateTime={entry.at}>
                      {entry.at}
                    </time>
                    {entry.repoId !== undefined && (
                      <span className="sk-logs__repo">{entry.repoId}</span>
                    )}
                  </div>
                  <p className="sk-logs__message">{resolveNotification(entry, t)}</p>
                  <Button
                    variant="plain"
                    className="sk-logs__copy"
                    onClick={() => copy(formatEntry(entry, t))}
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
