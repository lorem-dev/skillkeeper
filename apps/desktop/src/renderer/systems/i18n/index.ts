// Cross-cutting i18n system. Provides the store-bound translator hook plus the
// lazy catalog runtime used by the startup gate and the language switch.
export { useTranslator } from './useTranslator';
export type { Translator } from './useTranslator';
export { ensureCatalog, resolveLang } from './runtime';
