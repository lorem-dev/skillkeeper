/**
 * Full-screen repository sync task-list overlay. Lists queued/running/done/
 * error sync tasks (newest first) with a clear-finished action. Open state
 * lives in the store (tasksOpen); Escape or the close button dismisses it.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon, Spinner } from '@/shared/ui';
import { cx, fade } from '@/shared/lib';
import './TasksPage.scss';

export function TasksPage() {
  const tasksOpen = useSkillkeeperStore((s) => s.tasksOpen);
  const tasks = useSkillkeeperStore((s) => s.tasks);
  const closeTasks = useSkillkeeperStore((s) => s.closeTasks);
  const clearFinishedTasks = useSkillkeeperStore((s) => s.clearFinishedTasks);
  const t = useTranslator();

  // Newest first; never mutates store state.
  const entries = useMemo(() => [...tasks].reverse(), [tasks]);
  const hasFinished = tasks.some((task) => task.status === 'done' || task.status === 'error');

  // Focus the overlay once when it opens (mirrors LogsPage/TerminalPage).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tasksOpen) overlayRef.current?.focus();
  }, [tasksOpen]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') closeTasks();
  }

  return (
    <AnimatePresence>
      {tasksOpen && (
        <motion.div
          className="sk-tasks"
          role="dialog"
          aria-modal="true"
          aria-label={t('tasks.title')}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          ref={overlayRef}
          variants={fade}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <header className="sk-tasks__header">
            <h1 className="sk-tasks__title">{t('tasks.title')}</h1>
            <div className="sk-tasks__actions">
              <Button variant="secondary" onClick={clearFinishedTasks} disabled={!hasFinished}>
                {t('tasks.clear')}
              </Button>
              <Button
                variant="plain"
                className="sk-tasks__close"
                onClick={closeTasks}
                aria-label={t('common.close')}
              >
                <Icon name="close" />
              </Button>
            </div>
          </header>

          {entries.length === 0 ? (
            <div className="sk-tasks__empty">{t('tasks.empty')}</div>
          ) : (
            <ul className="sk-tasks__list">
              {entries.map((task) => (
                <li key={task.id} className={cx('sk-tasks__row', `sk-tasks__row--${task.status}`)}>
                  <div className="sk-tasks__info">
                    <span className="sk-tasks__repo">{task.repoName}</span>
                    <span className="sk-tasks__kind">{t(`tasks.kind.${task.kind}`)}</span>
                  </div>
                  <div className="sk-tasks__status">
                    {task.status === 'running' && <Spinner label={t('tasks.status.running')} labelHidden />}
                    <span className={cx('sk-tasks__label', `sk-tasks__label--${task.status}`)}>
                      {t(`tasks.status.${task.status}`)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
