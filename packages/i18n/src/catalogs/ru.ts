import type { Catalog } from './en.js';

/**
 * Russian catalog.
 *
 * Rules:
 * - Keys are ASCII-only (copied from en.ts).
 * - Values MAY use Cyrillic characters -- this is the ONE place in the
 *   codebase where non-ASCII characters are permitted.
 * - Missing keys fall back to `en` at runtime.
 */
export const ru: Partial<Catalog> = {
  'app.title': 'SkillKeeper',

  'nav.repositories': 'Репозитории',
  'nav.skills': 'Навыки',
  'nav.projects': 'Проекты',
  'nav.settings': 'Настройки',

  'config.invalidBanner':
    'Конфигурация содержит недопустимые разделы. Используются значения по умолчанию.',

  'skills.count': 'Установлено навыков: {n}',
};
