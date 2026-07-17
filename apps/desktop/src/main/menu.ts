import type { MenuItemConstructorOptions } from 'electron';
import type { Translator } from '@skillkeeper/i18n';

export type MenuNavTarget =
  | 'projects'
  | 'repositories'
  | 'skills-components'
  | 'skills-management'
  | 'mcp-components'
  | 'mcp-management'
  | 'settings';

/** Filesystem paths to template-PNG glyphs, keyed by glyph name (macOS only). */
export type MenuIcons = Partial<
  Record<'projects' | 'repositories' | 'skills' | 'mcp' | 'settings', string>
>;

export interface MenuDeps {
  readonly t: Translator;
  readonly onNavigate: (view: MenuNavTarget) => void;
  readonly onAbout: () => void;
  readonly icons?: MenuIcons;
}

/**
 * Build the macOS application-menu template. Pure (type-only electron import),
 * so it is node-unit-testable. Order: Skillkeeper, Edit, View, Settings,
 * Window, Help. Edit/Window/Help keep their `role` for behavior and carry an
 * explicit localized `label` (Electron role labels do not auto-localize).
 */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const { t, onNavigate, onAbout, icons } = deps;
  const nav = (view: MenuNavTarget): (() => void) => (): void => onNavigate(view);
  const withIcon = (
    key: keyof MenuIcons,
    item: MenuItemConstructorOptions,
  ): MenuItemConstructorOptions => {
    const p = icons?.[key];
    return p !== undefined ? { ...item, icon: p } : item;
  };
  return [
    {
      label: t('app.title'),
      submenu: [
        { label: t('menu.about'), click: (): void => onAbout() },
        { type: 'separator' },
        {
          label: t('nav.settings'),
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: nav('settings'),
        },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.delete') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        withIcon('projects', { label: t('nav.projects'), click: nav('projects') }),
        withIcon('repositories', { label: t('nav.repositories'), click: nav('repositories') }),
        withIcon('skills', {
          label: t('nav.skills'),
          submenu: [
            { label: t('skills.componentsTitle'), click: nav('skills-components') },
            { label: t('skills.managementTitle'), click: nav('skills-management') },
          ],
        }),
        withIcon('mcp', {
          label: t('nav.mcp'),
          submenu: [
            { label: t('mcp.componentsTitle'), click: nav('mcp-components') },
            { label: t('mcp.managementTitle'), click: nav('mcp-management') },
          ],
        }),
      ],
    },
    {
      label: t('nav.settings'),
      submenu: [withIcon('settings', { label: t('menu.openSettings'), click: nav('settings') })],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { type: 'separator' },
        { role: 'close', label: t('menu.close') },
      ],
    },
    { role: 'help', label: t('menu.help'), submenu: [] },
  ];
}
