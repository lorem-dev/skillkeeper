import type { Input } from 'electron';

/**
 * True when `input` is the Settings chord: Cmd+, on macOS, Ctrl+, elsewhere.
 * Matched by the PHYSICAL key `code` ('Comma'), NOT the produced character, so
 * it keeps working under a non-Latin keyboard layout (e.g. Cyrillic), where
 * the character on the comma key differs. Electron menu accelerators match the
 * character, which is why the shortcut is handled here via before-input-event
 * rather than as a registered accelerator.
 */
export function isSettingsShortcut(input: Input, platform: NodeJS.Platform): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.code !== 'Comma') return false;
  if (input.alt || input.shift) return false;
  return platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta;
}
