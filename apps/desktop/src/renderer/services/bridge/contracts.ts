// Transport contract types for the renderer <-> backend bridge.
//
// These describe the shapes exchanged over the Tauri command/event bridge
// (see `client.ts`). The definitions live here, in the bridge layer that owns
// the contract, and are re-exported from `./types`.
import type {
  Repository,
  Project,
  AgentKind,
  McpServerDef,
  McpTransport,
  McpIdentity,
} from './generated/core';

// -- editors -----------------------------------------------------------------

export interface EditorOption {
  readonly id: string;
  readonly name: string;
  readonly iconDataUrl?: string;
  readonly available: boolean;
}

export interface OpenResult {
  readonly ok: boolean;
  readonly error?: string;
}

// -- repositories ------------------------------------------------------------

export type RepoResult = { ok: true; repository: Repository } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Branch + skill-count summary for a cloned repository (for the card badges). */
export interface RepoInfo {
  /** Current branch, or null when the clone is missing or detached-unknown. */
  readonly branch: string | null;
  /** Number of skills resolved in the working tree. */
  readonly skillCount: number;
}

export interface AvailableSkill {
  readonly repoId: string;
  readonly repoName: string;
  /** Source repository remote URL; the stable identity for matching installs. */
  readonly remote: string;
  /** Optional one-level group (SkillId.group). */
  readonly group?: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Content hash of the skill body (excludes `.skid.yml`), for update detection. */
  readonly contentHash: string;
  /** The skill ships a GUIDE.md/RULES.md guidance file (drives the "rules" badge). */
  readonly hasGuidance: boolean;
}

// -- projects ----------------------------------------------------------------

export type ProjectResult = { ok: true; project: Project } | { ok: false; error: string };

export interface ProjectInfo {
  /** Total skills installed in the project (across agents). */
  readonly skillCount: number;
  /** Of those, how many were installed from a tracked repository. */
  readonly fromReposCount: number;
  /** Number of agents detected in the project folder (by markers). */
  readonly agentCount: number;
  /**
   * A data URL for the project's own icon when the folder carries one;
   * undefined otherwise, so the card falls back to the default project glyph.
   */
  readonly iconDataUrl?: string;
}

// -- skills ------------------------------------------------------------------

export interface SkillRef {
  readonly repoId: string;
  readonly group?: string;
  readonly name: string;
}

export interface ApplyArgs {
  /** Project UUID (recorded as target.projectId). */
  readonly projectId: string;
  /** Project folder path (used for PROJECT_DIR_ENV path resolution). */
  readonly projectPath: string;
  readonly agents: readonly AgentKind[];
  readonly install: readonly SkillRef[];
  readonly remove: readonly SkillRef[];
}

export interface ApplyProgress {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

export type ApplyResult =
  { ok: true; installed: number; removed: number } | { ok: false; error: string };

// -- mcp ---------------------------------------------------------------------

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

export interface McpInstallReq {
  readonly identity: McpIdentity;
  readonly def: McpServerDef;
  readonly values: Record<string, string>;
  /**
   * When set, `values` is ignored and the actual values are read from another
   * agent's already-installed instance of the SAME identity instead (its
   * `.skmcp.params.yml` entry for `instanceName`). Used by the skills-change
   * modal to add an agent to an already-installed MCP instance without ever
   * sending stored parameter values (which may hold secrets) back out to the
   * renderer. Falls back to `values` if the source cannot be read.
   */
  readonly copyParamsFrom?: { readonly agent: AgentKind; readonly instanceName: string };
}

/** Install/remove work for one agent within an applyMcp call. */
export interface McpBatch {
  readonly agent: AgentKind;
  readonly install: readonly McpInstallReq[];
  readonly remove: readonly { readonly instanceName: string }[];
}

/** Arguments for applyMcp. */
export interface ApplyMcpArgs {
  readonly projectId: string;
  readonly projectPath: string;
  readonly batches: readonly McpBatch[];
}

/** An install skipped because the agent cannot express the def's transport. */
export interface McpSkipped {
  readonly agent: AgentKind;
  readonly source: string;
  readonly transport: McpTransport;
}

/** Result of applyMcp. Never thrown across the bridge boundary. */
export type ApplyMcpResult =
  | {
      readonly ok: true;
      readonly installed: number;
      readonly removed: number;
      readonly skipped: McpSkipped[];
    }
  | { readonly ok: false; readonly error: string };

export interface McpInstall {
  /** The tracked project's id, or `'global'` for the (codex) global scope. */
  readonly projectId: string | 'global';
  readonly agent: AgentKind;
  readonly instanceName: string;
  readonly identity: {
    readonly remote?: string;
    readonly group?: string;
    readonly local?: string;
    readonly source: string;
  };
  readonly hash: string;
  /** Whether `.skmcp.params.yml` carries an entry for this instance. */
  readonly hasParams: boolean;
}

export interface McpUpdateReq {
  readonly projectId: string;
  readonly projectPath: string;
  readonly agent: AgentKind;
  /** The existing instance name; the reinstall reuses it verbatim. */
  readonly instanceName: string;
  readonly identity: McpIdentity;
  /** The NEW raw def from the current source (placeholders intact). */
  readonly def: McpServerDef;
  /** Merged param values (the caller has already collected any newly-required params). */
  readonly values: Record<string, string>;
}

/** Arguments for updateMcp. */
export interface UpdateMcpArgs {
  readonly updates: readonly McpUpdateReq[];
}

/** Result of updateMcp. Never thrown across the bridge boundary. */
export type UpdateMcpResult =
  { readonly ok: true; readonly updated: number } | { readonly ok: false; readonly error: string };

/** Arguments for mcpUpdatePreflight. */
export interface McpUpdatePreflightArgs {
  readonly projectId: string;
  readonly projectPath: string;
  readonly agent: AgentKind;
  /** The existing instance name to check stored params against. */
  readonly instanceName: string;
  /** The NEW/current source def (placeholders intact) to check params for. */
  readonly def: McpServerDef;
}

/** Result of mcpUpdatePreflight. Never thrown across the bridge boundary. */
export type McpUpdatePreflightResult =
  | { readonly ok: true; readonly missingParams: string[] }
  | { readonly ok: false; readonly error: string };
