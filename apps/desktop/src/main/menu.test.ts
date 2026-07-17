import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { Translator } from '@skillkeeper/i18n';
import { buildMenuTemplate, type MenuNavTarget } from './menu.js';

const t = ((key: string) => key) as unknown as Translator;

function build(onNavigate: (v: MenuNavTarget) => void): MenuItemConstructorOptions[] {
  return buildMenuTemplate({ t, onNavigate });
}

function byLabel(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((i) => i.label === label);
  if (found === undefined) throw new Error(`no menu item labelled ${label}`);
  return found;
}

function sub(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[];
}

describe('buildMenuTemplate', () => {
  it('lays out top-level menus in macOS-standard order', () => {
    const items = build(() => {});
    expect(items[0]?.label).toBe('app.title');
    expect(items[1]?.role).toBe('editMenu');
    expect(items[2]?.label).toBe('menu.view');
    expect(items[3]?.label).toBe('nav.mcp');
    expect(items[4]?.label).toBe('nav.settings');
    expect(items[5]?.role).toBe('windowMenu');
    expect(items[6]?.role).toBe('help');
  });

  it('puts About (native panel) and Settings in the app menu', () => {
    const appMenu = sub(build(() => {})[0]!);
    const about = byLabel(appMenu, 'menu.about');
    expect(about.role).toBe('about');
    const settings = byLabel(appMenu, 'nav.settings');
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    expect(settings.registerAccelerator).toBe(false);
  });

  it('navigates from View items', () => {
    const onNav = vi.fn();
    const view = sub(build(onNav)[2]!);
    (byLabel(view, 'nav.projects').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('projects');
    (byLabel(view, 'nav.repositories').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('repositories');
    const skills = sub(byLabel(view, 'nav.skills'));
    (byLabel(skills, 'skills.componentsTitle').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('skills-components');
    (byLabel(skills, 'skills.managementTitle').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('skills-management');
  });

  it('navigates from MCP items', () => {
    const onNav = vi.fn();
    const mcp = sub(build(onNav)[3]!);
    (byLabel(mcp, 'mcp.componentsTitle').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('mcp-components');
    (byLabel(mcp, 'mcp.managementTitle').click as unknown as () => void)();
    expect(onNav).toHaveBeenCalledWith('mcp-management');
  });

  it('navigates to settings from both the app menu and the Settings menu', () => {
    const onNav = vi.fn();
    const items = build(onNav);
    (byLabel(sub(items[0]!), 'nav.settings').click as unknown as () => void)();
    (byLabel(sub(items[4]!), 'menu.openSettings').click as unknown as () => void)();
    expect(onNav).toHaveBeenNthCalledWith(1, 'settings');
    expect(onNav).toHaveBeenNthCalledWith(2, 'settings');
  });
});
