/**
 * Generic page layout: a scrollable content column with a pinned header. No
 * product knowledge -- the concrete screens live in `pages/` and compose this.
 *
 * The header (a Toolbar via the `toolbar` slot, or a plain title) is pinned to
 * the top with a blurred backdrop. A matching blurred fade appears at the bottom
 * edge only when there is more content below, hinting at hidden content. Both
 * blurs share the same radius so they read as one treatment. Neither overlaps
 * the scrollbar. Styling is token-based and co-located in Page.scss.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Row } from '../Row';
import { cx, transitionMedium } from '../../lib';
import './Page.scss';

export interface PageProps {
  /** Page heading. Optional when a `toolbar` supplies the heading instead. */
  readonly title?: string;
  /**
   * Optional Toolbar rendered as the page header. When provided it supplies the
   * heading (its own title) and any trailing actions, and the default title
   * `<h1>` is not rendered. See shared/ui Toolbar.
   */
  readonly toolbar?: ReactNode;
  /**
   * Optional content docked to the bottom of the page viewport (NOT a footer in
   * the content flow): a bar pinned over the scroll area, sharing the bottom
   * fade's blurred backdrop and overlapping content that scrolls beneath it.
   * When set, the fade is always shown (the bar rides on it); when omitted, the
   * fade behaves normally (shown only when there is more content below). Pass a
   * falsy value to hide the bar -- callers show/hide it rather than disabling
   * its controls.
   */
  readonly dock?: ReactNode;
  readonly children?: ReactNode;
}

export function Page({ title, toolbar, dock, children }: PageProps) {
  const hasDock = Boolean(dock);
  const header =
    toolbar ??
    (title !== undefined ? (
      <Row className="sk-page__title-row">
        <h1 className="sk-page__title">{title}</h1>
      </Row>
    ) : null);

  const pageRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    // Publish the scrollbar width so the bottom fade can stop short of it.
    pageRef.current?.style.setProperty('--sk-scrollbar-w', `${el.offsetWidth - el.clientWidth}px`);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return undefined;
    update();
    // Recompute when the viewport or content size changes (async data, resize).
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.lastElementChild !== null) observer.observe(el.lastElementChild);
    return () => observer.disconnect();
  }, [update, children]);

  return (
    <main className="sk-page" ref={pageRef}>
      <div className="sk-page__scroll" ref={scrollRef} onScroll={update}>
        {header != null && <div className="sk-page__header">{header}</div>}
        <div className={cx('sk-page__body', hasDock && 'sk-page__body--docked')}>{children}</div>
      </div>
      <div
        className={cx(
          'sk-page__fade',
          'sk-page__fade--bottom',
          (canScrollDown || hasDock) && 'sk-page__fade--visible',
        )}
        aria-hidden="true"
      />
      {/* The dock's buttons rise/fade in when the dock appears and slide/fade
          out when it leaves (e.g. the skills Reset/Save bar toggling with
          pending changes). `initial={false}` skips the animation for a dock
          present on first render (an always-shown Add bar). */}
      <AnimatePresence initial={false}>
        {hasDock && (
          <motion.div
            key="dock"
            className="sk-page__dock"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={transitionMedium}
          >
            {dock}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
