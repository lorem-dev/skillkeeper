/**
 * xterm.js terminal surface. Starts (or re-attaches to) the Rust backend PTY,
 * replays its retained buffer, and pipes data + resize both ways over the
 * bridge. Stays mounted for the app's lifetime (TerminalPage only toggles the
 * overlay's visibility), so the PTY is always sized to the window and receives
 * live output continuously.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { bridgeClient } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useIsDark } from '@/systems/theme';
import { useTranslator } from '@/systems/i18n';
import { Menu } from '@/shared/ui';
import type { MenuItem } from '@/shared/ui';
import { errorLine, errorText, startWithRetry } from '../startShell.js';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.scss';

/** Read a --sk-* custom property's resolved value, trimmed. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The xterm theme resolved from the current `--sk-*` tokens (theme-aware, so
 *  it must be re-read whenever the app theme changes -- see the effect below). */
function buildTheme(): ITheme {
  return {
    background: cssVar('--sk-color-bg') || '#000000',
    foreground: cssVar('--sk-color-label') || '#ffffff',
    // Subtle, theme-neutral scrollbar slider (visible on light and dark),
    // in place of xterm's default near-invisible translucent white.
    scrollbarSliderBackground: 'rgba(128, 128, 128, 0.28)',
    scrollbarSliderHoverBackground: 'rgba(128, 128, 128, 0.45)',
    scrollbarSliderActiveBackground: 'rgba(128, 128, 128, 0.6)',
    // Explicit, theme-aware selection colors: xterm's default translucent
    // white is invisible on the light theme, which reads as "selection does
    // not work". Accent fill with the background as the text color stays
    // legible in both themes.
    selectionBackground: cssVar('--sk-color-accent') || '#3b82f6',
    selectionInactiveBackground: cssVar('--sk-color-accent') || '#3b82f6',
    selectionForeground: cssVar('--sk-color-bg') || '#000000',
  };
}

export function TerminalView() {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const isDark = useIsDark();
  const t = useTranslator();
  // Where the context menu was opened, and whether anything was selected at
  // that moment (checked once, on open, so the entry cannot go stale while the
  // menu is up). `null` means closed.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; hasSelection: boolean } | null>(
    null,
  );
  // A zero-size element placed at the click point: Menu positions against an
  // anchor's rect, and this is what turns a cursor position into one.
  const menuAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      // xterm needs a literal font stack -- it cannot resolve a CSS var().
      fontFamily: cssVar('--sk-font-mono') || 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
      fontSize: 13,
      allowProposedApi: true,
      // xterm's scrollbar (a VS Code scrollable element) defaults to a chunky
      // 14px. Its width is driven by overviewRuler.width; the overview ruler
      // itself only renders when decorations register for it (we register none),
      // so this just thins the scrollbar to match the app's 8px bars.
      overviewRuler: { width: 8 },
      theme: buildTheme(),
    });
    termRef.current = term;
    // xterm never copies/pastes on its own. Wire the platform shortcuts:
    // copy on Cmd+C (macOS) or Ctrl+Shift+C; paste on Cmd+V or Ctrl+Shift+V.
    // A bare Ctrl+C with no selection still falls through to send SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const modCombo = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey);
      if (modCombo && e.code === 'KeyC') {
        const selection = term.getSelection();
        if (selection.length === 0) return true;
        void writeText(selection);
        return false;
      }
      if (modCombo && e.code === 'KeyV') {
        void readText().then((text) => {
          if (text.length > 0) term.paste(text);
        });
        return false;
      }
      return true;
    });
    // Swallow terminal color queries (OSC 10/11/12). Programs/shells query the
    // fg/bg/cursor color at startup; xterm's default reply travels back over
    // async IPC and lands at the shell prompt too late, where ZLE echoes it as
    // garbage (e.g. "11;rgb:ffff/ffff/ffff"). Returning true marks them handled
    // so xterm sends no reply; apps fall back to their defaults.
    for (const code of [10, 11, 12]) {
      term.parser.registerOscHandler(code, () => true);
    }
    // Same for cursor/device status reports (CSI n -- e.g. CPR from `\e[6n`):
    // the late reply otherwise leaks a stray "R" into the shell prompt, which
    // then runs as a bogus command. Size detection uses SIGWINCH/resize, not CPR.
    term.parser.registerCsiHandler({ final: 'n' }, () => true);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Only ever fit against a REAL box. The fit addon derives the grid from
    // `parseInt(getComputedStyle(host).width/height)`, and a host with no
    // layout box (any hidden ancestor) reports the computed string "100%",
    // which parses to a 100x100 phantom box -- the PTY would then start a dozen
    // columns wide and the shell would hard-wrap its banner to that width, for
    // good (the wrap is baked into the bytes; no later resize can reflow it).
    // Skipping leaves xterm's 80x24 default, which the observer below corrects
    // as soon as the host has a size. The overlay is kept laid out while closed
    // (TerminalPage.scss hides it with `visibility`), so this normally passes.
    if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();

    // Subscribe before starting the PTY so no live chunk lands in the gap
    // between the start() call and the promise resolving with the buffer.
    let disposed = false;
    const { setTerminalError } = useSkillkeeperStore.getState();
    const offData = bridgeClient.onTerminalData((chunk) => term.write(chunk));
    const offExit = bridgeClient.onTerminalExit(() => {
      term.write('\r\n[process exited]\r\n');
      // The backend respawns the shell on exit. If that respawn failed there is
      // no session left -- and repository git silently reverts to running
      // headless -- so re-read the status rather than assume it came back.
      void bridgeClient
        .terminalStatus()
        .then((status) => {
          if (!disposed) setTerminalError(status.started ? null : (status.error ?? null));
        })
        .catch(() => undefined);
    });
    void startWithRetry(() => bridgeClient.startTerminal(term.cols, term.rows)).then(
      (buffer) => {
        if (disposed) return;
        if (buffer) term.write(buffer);
        setTerminalError(null);
      },
      (err: unknown) => {
        if (disposed) return;
        // Without this the failure is invisible: the view stays blank and the
        // rejected promise goes nowhere. Show it here AND log it, because the
        // same dead session is why a clone prints nothing in this terminal.
        const message = errorText(err);
        term.write(errorLine(`Terminal unavailable: ${message}`));
        setTerminalError(message);
      },
    );

    const onInput = term.onData((data) => bridgeClient.writeTerminal(data));
    let prevCols = term.cols;
    const ro = new ResizeObserver(() => {
      // Skip while hidden (the overlay is display:none -> zero size): fitting to
      // 0 would drop the scrollback and resize the PTY to nothing. The observer
      // fires again with the real size when the overlay is shown, refitting.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      if (term.cols !== prevCols) {
        prevCols = term.cols;
        // Scrollback was laid out at the old width; the shell's line-editor
        // repaints would reflow to the wrong columns. Drop it (both the on-screen
        // buffer and the retained one) -- the shell redraws its prompt on resize.
        term.clear();
        bridgeClient.clearTerminalBuffer();
      }
      bridgeClient.resizeTerminal(term.cols, term.rows);
    });
    ro.observe(el);
    term.focus();

    return () => {
      disposed = true;
      offData();
      offExit();
      onInput.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // The terminal is created once and stays mounted for the app's lifetime, so
  // re-apply the theme-aware colors whenever the app theme flips (otherwise the
  // terminal keeps the theme it was born with, looking inverted after a switch).
  // A rAF defers the token read until after `data-theme` is applied on <html>
  // (that effect lives in the app root, which commits after this child effect).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (term !== null) term.options.theme = buildTheme();
    });
    return () => cancelAnimationFrame(raf);
  }, [isDark]);

  const openMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const term = termRef.current;
    if (term === null) return;
    // Replace the webview's own menu, which offers nothing useful over a canvas
    // of terminal output.
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() });
  }, []);

  const closeMenu = useCallback(() => {
    setMenuAt(null);
    termRef.current?.focus();
  }, []);

  // Copy/paste/select-all as menu entries, not only as shortcuts: the keyboard
  // combination for a terminal differs per platform and is easy to miss, and
  // "Select all" gets output out even when a full-screen program has taken over
  // the mouse and drag-selection is unavailable.
  const items: MenuItem[] = [
    {
      id: 'copy',
      label: t('terminal.copy'),
      disabled: menuAt?.hasSelection !== true,
      onSelect: () => {
        const selection = termRef.current?.getSelection() ?? '';
        if (selection.length > 0) void writeText(selection);
      },
    },
    {
      id: 'paste',
      label: t('terminal.paste'),
      onSelect: () => {
        void readText().then((text) => {
          if (text.length > 0) termRef.current?.paste(text);
        });
      },
    },
    {
      id: 'select-all',
      label: t('terminal.selectAll'),
      onSelect: () => termRef.current?.selectAll(),
    },
  ];

  return (
    <>
      <div className="sk-terminal" ref={host} onContextMenu={openMenu} />
      {menuAt !== null && (
        <div
          className="sk-terminal__menu-anchor"
          ref={menuAnchor}
          style={{ top: menuAt.y, left: menuAt.x }}
        />
      )}
      <Menu
        open={menuAt !== null}
        onClose={closeMenu}
        anchorRef={menuAnchor}
        items={items}
        ariaLabel={t('terminal.title')}
      />
    </>
  );
}
