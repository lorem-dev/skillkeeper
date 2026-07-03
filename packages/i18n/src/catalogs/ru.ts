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

  'common.loading': 'Загрузка',
  'common.errorPrefix': 'Ошибка: {message}',

  'common.refresh': 'Обновить',
  'common.comingSoon': 'Скоро будет',
  'common.close': 'Закрыть',
  'common.clear': 'Очистить',
  'common.decrease': 'Уменьшить',
  'common.increase': 'Увеличить',

  'repositories.empty': 'Репозитории еще не добавлены.',
  'repositories.add': 'Добавить репозиторий',
  'repositories.lfs': 'LFS',
  'repositories.lastFetched': 'Последнее обновление: {when}',
  'repositories.neverFetched': 'Не обновлялось',
  'repositories.addRemote': 'URL удалённого репозитория',
  'repositories.addName': 'Название',
  'repositories.edit': 'Редактировать репозиторий',
  'repositories.save': 'Сохранить',
  'repositories.sync': 'Синхронизировать',
  'repositories.delete': 'Удалить',
  'repositories.deleteConfirm': 'Подтвердить удаление',
  'repositories.hasUpdate': 'Доступно обновление',

  'projects.empty': 'Проекты еще не отслеживаются.',
  'projects.add': 'Добавить проект',
  'projects.addedAt': 'Добавлено {when}',

  'skills.empty': 'Навыки еще не установлены.',
  'skills.add': 'Установить навык',
  'skills.searchPlaceholder': 'Поиск навыков',
  'skills.filterAgent': 'Агент',
  'skills.allAgents': 'Все агенты',
  'skills.noVersion': 'Без версии',
  'skills.installedFor': 'Установлен для',
  'skills.scope.project': 'Проект',
  'skills.scope.global': 'Глобально',
  'skills.source.repo': 'Из репозитория',
  'skills.source.local': 'Из локального пути',
  'skills.details.title': 'Детали навыка',
  'skills.details.files': 'Файлов: {n}',
  'skills.details.hooks': 'Хуков: {n}',
  'skills.details.installedAt': 'Установлено: {when}',
  'skills.details.destination': 'Назначение',
  'skills.verify': 'Проверить',
  'skills.update': 'Обновить',

  'settings.comingSoon': 'Экран настроек скоро появится.',
  'settings.section.general': 'Общие',
  'settings.section.updates': 'Обновления',
  'settings.section.agents': 'Агенты',
  'settings.section.executables': 'Исполняемые файлы',
  'settings.section.security': 'Безопасность',
  'settings.section.notifications': 'Уведомления',
  'settings.valid': 'Действительно',
  'settings.invalid': 'Недействительно',
  'settings.openConfig': 'Открыть файл конфигурации',
  'settings.openConfigInEditor': 'Открыть файл конфигурации в редакторе',
  'settings.editor.defaultApp': 'Открыть в приложении по умолчанию',
  'settings.openConfigFailed': 'Не удалось открыть файл конфигурации',
  'settings.theme': 'Тема',
  'settings.theme.system': 'Система',
  'settings.theme.light': 'Светлая',
  'settings.theme.dark': 'Тёмная',
  'settings.language': 'Язык',
  'settings.section.repositories': 'Репозитории',
  'settings.git': 'Git',
  'settings.gitDescription': 'Путь к исполняемому файлу git',
  'settings.updates.mode': 'Проверка обновлений',
  'settings.updates.mode.manual': 'Вручную',
  'settings.updates.mode.onStartup': 'При запуске',
  'settings.updates.mode.scheduled': 'По расписанию',
  'settings.updates.interval': 'Интервал проверки (часы)',
  'settings.agents.enabled': 'Активные агенты',
  'settings.agents.placeholder': 'Выберите агентов',
  'settings.agents.selected': 'Выбрано: {count}',
  'settings.notifications.enabled': 'Системные уведомления',

  'config.invalidBanner':
    'Конфигурация содержит недопустимые разделы. Используются значения по умолчанию.',

  'skills.count': 'Установлено навыков: {n}',
};
