import { describe, it, expect } from 'vitest';
import type { Input } from 'electron';
import { isSettingsShortcut } from './settingsShortcut.js';

function input(over: Partial<Input>): Input {
  const base: Input = {
    type: 'keyDown',
    key: ',',
    code: 'Comma',
    alt: false,
    control: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: [],
  };
  return { ...base, ...over };
}

describe('isSettingsShortcut', () => {
  it('matches Cmd+Comma on darwin (by physical code)', () => {
    expect(isSettingsShortcut(input({ meta: true }), 'darwin')).toBe(true);
  });
  it('matches Cmd+Comma on darwin even when the produced key differs (code is Comma)', () => {
    // A non-Latin layout produces a different `key` on the comma key; the
    // predicate matches on `code`, so `key` is irrelevant. Use an ASCII stand-in
    // (test files stay ASCII-only).
    expect(isSettingsShortcut(input({ meta: true, key: 'q' }), 'darwin')).toBe(true);
  });
  it('matches Ctrl+Comma off darwin', () => {
    expect(isSettingsShortcut(input({ control: true }), 'win32')).toBe(true);
    expect(isSettingsShortcut(input({ control: true }), 'linux')).toBe(true);
  });
  it('rejects the wrong modifier per platform', () => {
    expect(isSettingsShortcut(input({ control: true }), 'darwin')).toBe(false);
    expect(isSettingsShortcut(input({ meta: true }), 'win32')).toBe(false);
  });
  it('rejects when alt or shift is held', () => {
    expect(isSettingsShortcut(input({ meta: true, alt: true }), 'darwin')).toBe(false);
    expect(isSettingsShortcut(input({ meta: true, shift: true }), 'darwin')).toBe(false);
  });
  it('rejects a different physical key', () => {
    expect(isSettingsShortcut(input({ meta: true, code: 'Period' }), 'darwin')).toBe(false);
  });
  it('rejects when both meta and control are held', () => {
    expect(isSettingsShortcut(input({ meta: true, control: true }), 'darwin')).toBe(false);
    expect(isSettingsShortcut(input({ meta: true, control: true }), 'win32')).toBe(false);
  });
  it('rejects keyUp', () => {
    expect(isSettingsShortcut(input({ meta: true, type: 'keyUp' }), 'darwin')).toBe(false);
  });
});
