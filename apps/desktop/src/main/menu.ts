import type { MenuItemConstructorOptions } from 'electron';
import type { Translator } from '@skillkeeper/i18n';

/**
 * Navigation targets the menu can request. Mirror of the renderer's `View`
 * union (apps/desktop/src/renderer/app/navigation.ts). Kept as a local union
 * rather than imported, to avoid a main<-renderer build-boundary dependency;
 * the renderer validates incoming targets with `isView` before navigating.
 */
export type MenuNavTarget =
  | 'projects'
  | 'repositories'
  | 'skills-components'
  | 'skills-management'
  | 'mcp-components'
  | 'mcp-management'
  | 'settings';

export interface MenuDeps {
  readonly t: Translator;
  readonly onNavigate: (view: MenuNavTarget) => void;
}

/**
 * Build the macOS application-menu template. Pure -- no Electron side effects,
 * so it is unit-testable in node. Standard-order layout:
 * Skillkeeper, Edit, View, MCP, Settings, Window, Help.
 *
 * Edit/Window/Help are `role` menus (OS-localized). The app menu's title is
 * taken by macOS from the bundle/product name regardless of the `label` here
 * (dev shows "Electron"; a packaged build shows the product name).
 */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const { t, onNavigate } = deps;
  const nav = (view: MenuNavTarget): (() => void) => (): void => onNavigate(view);
  return [
    {
      label: t('app.title'),
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        {
          label: t('nav.settings'),
          // Show the Cmd+, hint but do NOT register it: the real trigger is the
          // physical-key before-input-event handler (layout independent).
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: nav('settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('nav.projects'), click: nav('projects') },
        { label: t('nav.repositories'), click: nav('repositories') },
        {
          label: t('nav.skills'),
          submenu: [
            { label: t('skills.componentsTitle'), click: nav('skills-components') },
            { label: t('skills.managementTitle'), click: nav('skills-management') },
          ],
        },
      ],
    },
    {
      label: t('nav.mcp'),
      submenu: [
        { label: t('mcp.componentsTitle'), click: nav('mcp-components') },
        { label: t('mcp.managementTitle'), click: nav('mcp-management') },
      ],
    },
    {
      label: t('nav.settings'),
      submenu: [{ label: t('menu.openSettings'), click: nav('settings') }],
    },
    { role: 'windowMenu' },
    // macOS injects the Help search field automatically for the help-role menu.
    { role: 'help', submenu: [] },
  ];
}
