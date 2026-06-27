/**
 * CLI-only message map.
 *
 * The shared i18n catalog (@skillkeeper/i18n) is the source of truth for strings
 * used across front ends. A handful of strings are specific to the CLI and have
 * no catalog key; rather than edit the i18n package, they live here in a small
 * map that mirrors the i18n interpolation pattern ({name} placeholders). The CLI
 * translator is consulted first; these are the fallback for CLI-only keys.
 *
 * Keep this ASCII-only, like the English catalog.
 */

/** CLI-only English strings, keyed like the i18n catalog. */
export const cliMessages = {
  /** A project-scope operation was requested but no project path could be resolved. */
  'cli.project.required':
    'A project-scope operation needs a project directory. Pass --project <path>, run from inside a project, or use --global.',
} as const;

/** Union of CLI-only message keys. */
export type CliMessageKey = keyof typeof cliMessages;

/** Replace {name} tokens in a template with values from vars. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : `{${name}}`;
  });
}

/**
 * Resolve a CLI-only message by key, with optional interpolation. This mirrors
 * the i18n translator shape so call sites read the same way.
 */
export function cliMessage(key: CliMessageKey, vars?: Record<string, string>): string {
  const raw = cliMessages[key];
  return vars !== undefined ? interpolate(raw, vars) : raw;
}
