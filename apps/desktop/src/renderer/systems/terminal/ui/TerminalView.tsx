/**
 * xterm.js terminal surface. Starts (or re-attaches to) the main-process PTY,
 * replays its retained buffer, and pipes data + resize both ways over the
 * bridge. Mounted only while the terminal overlay is open (see TerminalPage),
 * so a fresh xterm instance is created each time and the buffer replay keeps
 * the screen looking continuous across opens.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
      theme: {
        background: cssVar('--sk-color-bg') || '#000000',
        foreground: cssVar('--sk-color-label') || '#ffffff',
      },
    });
    // Swallow terminal color queries (OSC 10/11/12). Programs/shells query the
    // fg/bg/cursor color at startup; xterm's default reply travels back over
    // async IPC and lands at the shell prompt too late, where ZLE echoes it as
    // garbage (e.g. "11;rgb:ffff/ffff/ffff"). Returning true marks them handled
    // so xterm sends no reply; apps fall back to their defaults.
    for (const code of [10, 11, 12]) {
      term.parser.registerOscHandler(code, () => true);
    }
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
    const ro = new ResizeObserver(() => {
      fit.fit();
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
