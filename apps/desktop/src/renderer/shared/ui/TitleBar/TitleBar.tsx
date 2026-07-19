/**
 * Frameless-window title bar for Windows/Linux: a thin draggable strip at the
 * very top of the app that replaces the native OS title bar. The whole strip is
 * a drag region (so the window can be moved by it) except the custom
 * {@link WindowControls} on the right.
 *
 * macOS does NOT use this: there the app content reaches the top, the native
 * traffic lights float over the sidebar, and the drag regions live on the real
 * content (see app/WindowChrome and App.scss).
 *
 * Pure/presentational: the app wires `platform`, `maximized`, and the handlers
 * (see app/WindowChrome).
 */
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../../lib';
import { WindowControls } from '../WindowControls';
import type { WindowControlLabels } from '../WindowControls';
import './TitleBar.scss';

export interface TitleBarProps {
  readonly platform: 'windows' | 'linux';
  /** Optional leading bar title. */
  readonly title?: ReactNode;
  readonly maximized?: boolean;
  readonly onMinimize?: () => void;
  readonly onToggleMaximize?: () => void;
  readonly onClose?: () => void;
  readonly controlLabels?: Partial<WindowControlLabels>;
}

export function TitleBar({
  platform,
  title,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
  controlLabels,
}: TitleBarProps): ReactElement {
  return (
    // The strip itself is the window-drag handle: Tauri starts a drag only when
    // the pressed element is tagged, so the controls (separate children) stay
    // clickable. WebKit ignores the old app-region CSS; this drives dragging.
    <div className={cx('sk-titlebar', `sk-titlebar--${platform}`)} data-tauri-drag-region>
      {title !== undefined && (
        <span className="sk-titlebar__title" data-tauri-drag-region>
          {title}
        </span>
      )}
      <WindowControls
        variant={platform}
        maximized={maximized}
        onMinimize={onMinimize}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
        labels={controlLabels}
        className="sk-titlebar__controls"
      />
    </div>
  );
}
