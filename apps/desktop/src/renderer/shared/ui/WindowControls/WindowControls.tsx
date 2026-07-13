/**
 * Custom window controls (minimize / maximize-restore / close) for the
 * frameless title bar on platforms without native overlay controls -- i.e.
 * Windows and Linux. macOS uses its native traffic lights instead (the window
 * keeps them via `titleBarStyle: 'hidden'`), so this component is never
 * rendered there.
 *
 * Pure/presentational: the caller supplies the handlers and the maximized
 * state (which swaps the middle glyph between "maximize" and "restore"). The
 * buttons opt out of the drag region so they stay clickable inside the bar.
 * The `variant` picks the platform chrome: flat full-height buttons with a red
 * close hover (Windows), or small pill/circular buttons (Linux).
 */
import type { ReactElement } from 'react';
import { cx } from '../../lib';
import './WindowControls.scss';

export interface WindowControlLabels {
  readonly minimize: string;
  readonly maximize: string;
  readonly restore: string;
  readonly close: string;
}

export interface WindowControlsProps {
  /** Platform chrome. macOS is intentionally absent (native controls). */
  readonly variant: 'windows' | 'linux';
  /** Whether the window is maximized (swaps the middle glyph to "restore"). */
  readonly maximized?: boolean;
  readonly onMinimize?: () => void;
  readonly onToggleMaximize?: () => void;
  readonly onClose?: () => void;
  /** Accessible labels; English defaults so the component works standalone. */
  readonly labels?: Partial<WindowControlLabels>;
  readonly className?: string;
}

const DEFAULT_LABELS: WindowControlLabels = {
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
};

// 12x12 line glyphs, stroked in currentColor so hover states recolor them.
function MinimizeGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M2.5 6 H9.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximizeGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function RestoreGlyph(): ReactElement {
  // Two overlapping squares: a full front square and the back square's exposed
  // top-right corner.
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect x="2.5" y="3.5" width="6" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
      <path d="M4.5 3.5 V2.5 H9.5 V7.5 H8.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CloseGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

export function WindowControls({
  variant,
  maximized = false,
  onMinimize,
  onToggleMaximize,
  onClose,
  labels,
  className,
}: WindowControlsProps): ReactElement {
  const l = { ...DEFAULT_LABELS, ...labels };
  return (
    <div className={cx('sk-winctl', `sk-winctl--${variant}`, className)}>
      <button
        type="button"
        className="sk-winctl__btn sk-winctl__btn--min"
        aria-label={l.minimize}
        onClick={onMinimize}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="sk-winctl__btn sk-winctl__btn--max"
        aria-label={maximized ? l.restore : l.maximize}
        onClick={onToggleMaximize}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="sk-winctl__btn sk-winctl__btn--close"
        aria-label={l.close}
        onClick={onClose}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
