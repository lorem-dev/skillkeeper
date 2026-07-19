/**
 * xterm.js terminal surface. Starts (or re-attaches to) the Rust backend PTY,
 * replays its retained buffer, and pipes data + resize both ways over the
 * bridge. Stays mounted for the app's lifetime (TerminalPage only toggles the
 * overlay's visibility), so the PTY is always sized to the window and receives
 * live output continuously.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { bridgeClient } from '@/services/bridge';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.scss';

/** Read a --sk-* custom property's resolved value, trimmed. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalView() {
  const host = useRef<HTMLDivElement>(null);

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
      theme: {
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
      },
    });
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
    fit.fit();

    // Subscribe before starting the PTY so no live chunk lands in the gap
    // between the start() call and the promise resolving with the buffer.
    let disposed = false;
    const offData = bridgeClient.onTerminalData((chunk) => term.write(chunk));
    const offExit = bridgeClient.onTerminalExit(() => term.write('\r\n[process exited]\r\n'));
    void bridgeClient.startTerminal(term.cols, term.rows).then((buffer) => {
      if (!disposed && buffer) term.write(buffer);
    });

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
    };
  }, []);

  return <div className="sk-terminal" ref={host} />;
}
