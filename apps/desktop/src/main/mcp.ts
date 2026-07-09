/**
 * MCP preset catalog discovery for the desktop main process.
 *
 * Mirrors `listAvailableSkills` (repositories.ts): for each cloned repository,
 * read the mcp.yml/mcp.yaml declared at the repo root (no group) and inside
 * each skill-group directory (group = the directory name, taken from the
 * distinct groups already resolved by `resolveSkills`), parse each file via
 * `parseMcpConfig`, and flatten every declared server into one `AvailableMcp`.
 *
 * File choice: when a directory has both `mcp.yml` and `mcp.yaml`, `mcp.yml`
 * is read and `mcp.yaml` is ignored entirely (even if `mcp.yml` fails to
 * parse) -- this mirrors the documented precedence, not a fallback chain.
 *
 * A directory's file failing to parse is reported via `console.warn` and
 * skipped; it never fails the rest of the catalog build.
 */
import { loadState, resolveSkills, parseMcpConfig, hashMcpDef, McpConfigError } from '@skillkeeper/core';
import type { FsPort, McpServerDef } from '@skillkeeper/core';

/** One MCP server preset available from a cloned repository. */
export interface AvailableMcp {
  readonly repoId: string;
  /** Source repository remote URL; the stable identity for matching installs. */
  readonly remote: string;
  /** Optional one-level group (the skill-group directory name); absent for root. */
  readonly group?: string;
  readonly def: McpServerDef;
  /** Content hash of the raw def (excludes `name`), for update detection. */
  readonly hash: string;
}

const MCP_FILE_NAMES = ['mcp.yml', 'mcp.yaml'] as const;

/** The minimal deps this module needs; a subset of the desktop `RepoDeps` shape. */
export interface McpCatalogDeps {
  readonly fs: FsPort;
  readonly statePath: string;
}

/**
 * Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
 * (preferring `mcp.yml`). Returns an empty list when neither file exists, or
 * when the file found fails to parse (a warning is reported via `warn` in
 * that case).
 */
async function readMcpDefs(
  fs: FsPort,
  dir: string,
  warn: (message: string) => void,
): Promise<McpServerDef[]> {
  for (const fileName of MCP_FILE_NAMES) {
    const filePath = `${dir}/${fileName}`;
    if (!(await fs.exists(filePath))) continue;
    try {
      const { servers } = parseMcpConfig(await fs.readFile(filePath));
      return servers;
    } catch (err) {
      const detail = err instanceof McpConfigError ? err.message : String(err);
      warn(`Skipping invalid MCP config at "${filePath}": ${detail}`);
      return [];
    }
  }
  return [];
}

/**
 * Every MCP server preset available across all cloned repositories: a root
 * mcp.yml/mcp.yaml plus one per skill-group directory. Repos whose clone is
 * missing or fails to resolve are skipped, mirroring `listAvailableSkills`.
 */
export async function listAvailableMcp(deps: McpCatalogDeps): Promise<AvailableMcp[]> {
  const out: AvailableMcp[] = [];
  const warn = (message: string): void => {
    console.warn(`[mcp] ${message}`);
  };

  let repos;
  try {
    repos = (await loadState(deps.fs, deps.statePath)).repositories;
  } catch {
    return out;
  }

  for (const repo of repos) {
    try {
      if (!(await deps.fs.exists(repo.localPath))) continue;

      const push = (group: string | undefined, defs: McpServerDef[]): void => {
        for (const def of defs) {
          out.push({ repoId: repo.id, remote: repo.url, group, def, hash: hashMcpDef(def) });
        }
      };

      push(undefined, await readMcpDefs(deps.fs, repo.localPath, warn));

      // Group candidates come from the on-disk directory holding each resolved
      // skill (`rootPath`'s first segment when nested one level), not from the
      // skill's declared `id.group`: a repo using `skillkeeper.repo.yaml` may
      // assign a custom group label decoupled from the directory layout, but an
      // mcp.yml sits in the actual directory, not under that label.
      const { skills } = await resolveSkills(deps.fs, repo.localPath);
      const groups = new Set<string>();
      for (const skill of skills) {
        const parts = skill.rootPath.split('/');
        if (parts.length >= 2) groups.add(parts[0]!);
      }
      for (const group of groups) {
        push(group, await readMcpDefs(deps.fs, `${repo.localPath}/${group}`, warn));
      }
    } catch {
      // Skip a repo that cannot be resolved; others still list.
    }
  }
  return out;
}
