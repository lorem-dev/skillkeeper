/**
 * Ensure a project's `.gitignore` excludes the MCP parameter value files
 * (`.skmcp.params.yml` / `.skmcp.params.yaml`), which hold raw secrets and must
 * never be committed. Idempotent: writes only when a line is actually missing.
 */
import { SKMCP_PARAMS_FILE } from './skmcp.js';
import type { FsPort } from '../kernel/ports.js';

/** Sibling `.yaml`-spelled variant of {@link SKMCP_PARAMS_FILE}. */
const SKMCP_PARAMS_FILE_YAML = '.skmcp.params.yaml';

const GITIGNORE_COMMENT = '# SkillKeeper MCP parameter values';
const GITIGNORE_LINES = [SKMCP_PARAMS_FILE, SKMCP_PARAMS_FILE_YAML] as const;

/**
 * Ensure `<projectPath>/.gitignore` ignores both MCP parameter value files.
 *
 * - Creates the file (comment + both lines) when absent.
 * - Appends missing lines when present but incomplete, preserving existing
 *   content; the comment is only (re-)added when not already present.
 * - Performs no write when both lines are already present.
 */
export async function ensureGitignore(fs: FsPort, projectPath: string): Promise<void> {
  const path = `${projectPath}/.gitignore`;
  const exists = await fs.exists(path);
  const existing = exists ? await fs.readFile(path) : '';
  const existingLines = new Set(existing.split(/\r?\n/));

  const missing = GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (!exists) {
    await fs.writeFile(path, `${GITIGNORE_COMMENT}\n${GITIGNORE_LINES.join('\n')}\n`);
    return;
  }
  if (missing.length === 0) return;

  const additions = existingLines.has(GITIGNORE_COMMENT) ? missing : [GITIGNORE_COMMENT, ...missing];
  const trimmed = existing.replace(/\r?\n+$/, '');
  const next = trimmed === '' ? `${additions.join('\n')}\n` : `${trimmed}\n${additions.join('\n')}\n`;
  await fs.writeFile(path, next);
}
