import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { Translator } from '@skillkeeper/i18n';
import { buildMenuTemplate } from './menu.js';

const t = ((key: string) => key) as unknown as Translator;
const build = (over: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) =>
  buildMenuTemplate({ t, onNavigate: () => {}, onAbout: () => {}, ...over });
const byLabel = (items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions => {
  const f = items.find((i) => i.label === label);
  if (f === undefined) throw new Error(`no item ${label}`);
  return f;
};
const sub = (i: MenuItemConstructorOptions) => i.submenu as MenuItemConstructorOptions[];
const click = (i: MenuItemConstructorOptions) => (i.click as unknown as () => void)();

describe('buildMenuTemplate', () => {
  it('orders menus Skillkeeper, Edit, View, Settings, Window, Help (no top-level MCP)', () => {
    const items = build();
    expect(items[0]?.label).toBe('app.title');
    expect(items[1]?.label).toBe('menu.edit');
    expect(items[2]?.label).toBe('menu.view');
    expect(items[3]?.label).toBe('nav.settings');
    expect(items[4]?.label).toBe('menu.window');
    expect(items[5]?.label).toBe('menu.help');
    expect(items.find((i) => i.label === 'nav.mcp' && i !== undefined && items.indexOf(i) < 6)).toBeUndefined();
  });

  it('nests MCP inside View', () => {
    const view = sub(build()[2]!);
    const mcp = byLabel(view, 'nav.mcp');
    const mcpItems = sub(mcp);
    expect(mcpItems.map((i) => i.label)).toEqual(['mcp.componentsTitle', 'mcp.managementTitle']);
  });

  it('localizes Edit items with role + label', () => {
    const edit = sub(build()[1]!);
    const undo = byLabel(edit, 'menu.undo');
    expect(undo.role).toBe('undo');
    expect(byLabel(edit, 'menu.selectAll').role).toBe('selectAll');
  });

  it('localizes Window items with role + label', () => {
    const win = sub(build()[4]!);
    expect(byLabel(win, 'menu.minimize').role).toBe('minimize');
    expect(byLabel(win, 'menu.close').role).toBe('close');
  });

  it('Help menu uses role help and localized label', () => {
    expect(build()[5]?.role).toBe('help');
  });

  it('app menu: About via onAbout (not role about), localized Quit/Hide', () => {
    const onAbout = vi.fn();
    const appMenu = sub(build({ onAbout })[0]!);
    const about = byLabel(appMenu, 'menu.about');
    expect(about.role).toBeUndefined();
    click(about);
    expect(onAbout).toHaveBeenCalledTimes(1);
    expect(byLabel(appMenu, 'menu.quit').role).toBe('quit');
    expect(byLabel(appMenu, 'menu.hide').role).toBe('hide');
  });

  it('navigates from View items including nested MCP', () => {
    const onNavigate = vi.fn();
    const view = sub(build({ onNavigate })[2]!);
    click(byLabel(view, 'nav.projects'));
    expect(onNavigate).toHaveBeenCalledWith('projects');
    click(byLabel(sub(byLabel(view, 'nav.mcp')), 'mcp.componentsTitle'));
    expect(onNavigate).toHaveBeenCalledWith('mcp-components');
  });

  it('attaches icons only when provided', () => {
    const view = sub(build()[2]!);
    expect(byLabel(view, 'nav.projects').icon).toBeUndefined();
    const view2 = sub(build({ icons: { projects: '/tmp/projectsTemplate.png' } })[2]!);
    expect(byLabel(view2, 'nav.projects').icon).toBe('/tmp/projectsTemplate.png');
  });
});
