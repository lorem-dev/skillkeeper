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
  Scope,
} from './generated/core';
import type { AppUpdateOffer } from './generated/AppUpdateOffer';
import type { UpsertNote } from './generated/core/UpsertNote';

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
  /** Optional group path, up to three levels deep (SkillId.group). */
  readonly group?: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Skill paths in the same repository that this skill needs (absolute:
   *  `group/name`, or `name` when ungrouped). */
  readonly requires?: string[];
  /** Content hash of the skill body (excludes `.skid.yml`), for update detection. */
  readonly contentHash: string;
  /** The skill ships a GUIDE.md/RULES.md guidance file (drives the "rules" badge). */
  readonly hasGuidance: boolean;
}

/**
 * A skill-resolution warning, attributed to the repository it came from.
 *
 * Resolution never fails: it reports warnings instead. A warning is the only
 * signal that a `SKILL.md` exists but cannot be installed -- nested deeper than
 * the maximum group depth, a malformed manifest, an unparsable
 * `skillkeeper.repo.yaml`. Without surfacing it, such a skill is simply absent
 * from the tree with no explanation.
 */
export interface SkillResolveWarning {
  readonly repoId: string;
  readonly repoName: string;
  /** Already-composed English message from the core resolver (not a i18n key). */
  readonly message: string;
}

/** The `skills_available` payload: the catalog plus any resolution warnings. */
export interface AvailableSkillsResult {
  readonly skills: AvailableSkill[];
  readonly warnings: SkillResolveWarning[];
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
  /** Project UUID (recorded as target.projectId). Ignored at global scope. */
  readonly projectId: string;
  /** Project folder path (used for PROJECT_DIR_ENV path resolution). Ignored at global scope. */
  readonly projectPath: string;
  readonly agents: readonly AgentKind[];
  readonly install: readonly SkillRef[];
  readonly remove: readonly SkillRef[];
  /**
   * Which scope to write into. Required, even though Rust defaults an absent
   * field to `project`: an omitted scope is how a global operation silently
   * became a project one. Build it with `applyScope` rather than by hand.
   */
  readonly scope: Scope;
}

export interface ApplyProgress {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

export type ApplyResult =
  | {
      ok: true;
      /**
       * Count of skills actually installed. The backend expands the install
       * list to its dependency closure before installing, so this can be
       * larger than the number of skills requested -- it does not echo the
       * request.
       */
      installed: number;
      removed: number;
    }
  | { ok: false; error: string };

// -- mcp ---------------------------------------------------------------------

/**
 * An `McpServerDef` exactly as the backend sends it: `parameters` may be
 * ABSENT, where the generated type says it never is.
 *
 * `McpServerDef.parameters` carries `#[serde(skip_serializing_if =
 * "BTreeMap::is_empty")]` in Rust (`crates/skillkeeper-core/src/mcp/model.rs`),
 * so a def with no `parameters:` block -- which is every `mcp.yml` authored
 * before that block existed -- arrives over the bridge with no `parameters` key
 * at all. ts-rs cannot express a `skip_serializing_if` on a non-`Option` field,
 * so the generated `McpServerDef` declares the field REQUIRED: the type
 * promises a map the wire does not always carry, and a `def.parameters[name]`
 * read throws on those defs with nothing in TypeScript to flag it.
 *
 * Declaring the inbound shape honestly here is what makes the fix enforceable
 * rather than remembered: assigning one of these straight into renderer state
 * is a type error, so the only way through is `normalizeMcpDefFromBridge`
 * (`@/app/store`) -- after which the generated type is TRUE for every reader
 * and no consumer needs a guard.
 *
 * OUTBOUND defs (`McpInstallReq`, `McpUpdateReq`, `McpUpdatePreflightArgs`)
 * stay `McpServerDef`: the renderer always builds those with the key present,
 * and Rust reads an empty map back to exactly what it would have defaulted to.
 */
export type RawMcpServerDef = Omit<McpServerDef, 'parameters'> & {
  readonly parameters?: McpServerDef['parameters'];
};

export interface AvailableMcp {
  readonly repoId: string;
  /** Source repository remote URL; the stable identity for matching installs. */
  readonly remote: string;
  /** Optional one-level group (the skill-group directory name); absent for root. */
  readonly group?: string;
  /** As sent, not as typed -- see {@link RawMcpServerDef}. */
  readonly def: RawMcpServerDef;
  /** Content hash of the raw def (excludes `name`), for update detection. */
  readonly hash: string;
}

/**
 * One problem found while reading a repository's `mcp.yml`: a file that could
 * not be parsed at all, or one that only parsed because of the YAML leniency
 * (a bare `{param}` header, which YAML reads as a mapping). Structurally the
 * same record as {@link SkillResolveWarning} and handled by the same store
 * action, so a preset that went missing reads the same way as a skill that did.
 */
export interface McpConfigWarning {
  readonly repoId: string;
  readonly repoName: string;
  /** Already-composed English message from the backend (not an i18n key). */
  readonly message: string;
}

/** The `mcp_list_available` payload: the catalog plus any warnings. */
export interface AvailableMcpResult {
  readonly mcp: AvailableMcp[];
  readonly warnings: McpConfigWarning[];
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
  /** Ignored at global scope. */
  readonly projectId: string;
  /** Ignored at global scope. */
  readonly projectPath: string;
  readonly batches: readonly McpBatch[];
  /** Which scope to write into. Required; see {@link ApplyArgs.scope}. */
  readonly scope: Scope;
}

/**
 * One install `applyMcp` declined to perform: one whose transport the agent
 * cannot express, or one carrying an oauth client the agent cannot express.
 * Removes are never skipped -- they carry no def, so neither rule applies.
 */
export interface McpSkipped {
  readonly agent: AgentKind;
  /** The preset's source name. */
  readonly source: string;
  /** Which rule declined it; `mcpSkipsToMessages` turns it into a message. */
  readonly reason: 'transport' | 'oauth';
  /**
   * The transport that could not be expressed; absent for an oauth skip, whose
   * transport was perfectly expressible.
   */
  readonly transport?: McpTransport;
}

/** One install `applyMcp` performed, and what the writer could not express. */
export interface McpInstalled {
  readonly agent: AgentKind;
  readonly instanceName: string;
  /**
   * Writer notes, empty when nothing was dropped. The install succeeded, so
   * these are not errors -- but a silently dropped auth field reads as
   * configured when it is not, so they are shown.
   */
  readonly notes: readonly UpsertNote[];
}

/** Result of applyMcp. Never thrown across the bridge boundary. */
export type ApplyMcpResult =
  | {
      readonly ok: true;
      readonly installed: readonly McpInstalled[];
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
  /** Which scope to write into. Required; see {@link ApplyArgs.scope}. */
  readonly scope: Scope;
}

/** Result of updateMcp. Never thrown across the bridge boundary. */
export type UpdateMcpResult =
  | {
      readonly ok: true;
      /** One entry per updated instance; an update is a reinstall, notes and all. */
      readonly updated: readonly McpInstalled[];
      readonly skipped: McpSkipped[];
    }
  | { readonly ok: false; readonly error: string };

/** Arguments for mcpUpdatePreflight. */
export interface McpUpdatePreflightArgs {
  /** Ignored at global scope. */
  readonly projectId: string;
  /** Ignored at global scope. */
  readonly projectPath: string;
  readonly agent: AgentKind;
  /** The existing instance name to check stored params against. */
  readonly instanceName: string;
  /** The NEW/current source def (placeholders intact) to check params for. */
  readonly def: McpServerDef;
  /** Which scope to read from. Required; see {@link ApplyArgs.scope}. */
  readonly scope: Scope;
}

/** Result of mcpUpdatePreflight. Never thrown across the bridge boundary. */
export type McpUpdatePreflightResult =
  | { readonly ok: true; readonly missingParams: string[] }
  | { readonly ok: false; readonly error: string };

// -- terminal -----------------------------------------------------------------

/**
 * Whether a shell session is live, and why not when it is not.
 *
 * Repository git runs through the terminal only while a session exists and
 * falls back to a silent headless port otherwise, so `error` is what separates
 * "the clone printed nothing" from "the clone never reached the terminal".
 */
export interface TerminalStatus {
  readonly started: boolean;
  /** The last shell/git launch failure; absent while the terminal is healthy. */
  readonly error?: string;
}

// -- app update ----------------------------------------------------------

// The DTO itself IS ts-rs generated (see `commands/app_update.rs`), unlike the
// rest of this file -- re-exported from its single generated file (there is no
// barrel for it the way `generated/core` and `generated/config` have one,
// since it is the only ts-rs type the Tauri crate itself exports).
export type { AppUpdateOffer } from './generated/AppUpdateOffer';

/**
 * `app_update_check`'s result: the decided offer (if any) plus whether this
 * attempt actually reached the network. Not ts-rs generated: a plain
 * `Serialize` struct in `commands/app_update.rs`, same as `AppUpdateProgress`
 * below.
 *
 * `suppressed` is `true` for either of the backend's automatic-check gates: a
 * request inside the 24-hour interval since the last real
 * attempt. Either way `offer` is whatever was already known rather than a
 * fresh decision, which is why the task list shows this outcome as `skipped`
 * rather than `done` -- see `runAppUpdateCheck` in `app/store/store.ts`.
 */
export interface CheckOutcome {
  readonly offer: AppUpdateOffer | null;
  readonly suppressed: boolean;
}

/** `appUpdate:progress` payload. Not ts-rs generated: a private struct in
 *  `commands/app_update.rs`, same as `SshKeyDto` below. */
export interface AppUpdateProgress {
  readonly percent: number;
}

/** `appUpdate:ready` payload. */
export interface AppUpdateReady {
  readonly version: string;
  readonly path: string;
}

/** `appUpdate:failed` payload. `phase` says which half failed, so the
 *  renderer can tell a network/verification failure downloading the artifact
 *  apart from a failure installing one already verified (e.g. macOS refusing
 *  to copy the app into place).
 *
 *  `path`/`offer` are present ONLY for a marker-based install failure
 *  discovered on a fresh launch: on the two platforms where an install
 *  replaces the running application, a failure like this happened inside a
 *  helper script after the PREVIOUS run had already exited, so the ready
 *  dialog carrying the manual fallback never opened in this session at all.
 *  These two fields are what `useAppUpdateSchedule` needs to reopen it
 *  itself. Absent for a download failure, and for a same-session install
 *  failure, where the ready dialog is already open.
 *
 *  `installReady` says whether the backend re-verified the preserved
 *  artifact and rehydrated its session, so a same-click "Install now" from
 *  the reopened dialog can retry without a fresh download. Always present
 *  (defaults to `false` when irrelevant, e.g. a download failure); only
 *  meaningful together with `path`. */
export interface AppUpdateFailed {
  readonly message: string;
  readonly phase: 'download' | 'install';
  readonly path?: string;
  readonly offer?: AppUpdateOffer;
  readonly installReady: boolean;
}

// -- ssh key -------------------------------------------------------------

/**
 * The configured SSH key's path and usability, as reported by the backend's
 * in-memory key store. Not a ts-rs type: `commands/ssh_key.rs` returns a plain
 * `Serialize` DTO, same as `RepoResult` and friends.
 */
export interface SshKeyDto {
  readonly path?: string;
  readonly state:
    | 'notConfigured'
    | 'missing'
    | 'notAKey'
    | 'unencrypted'
    | 'locked'
    | 'unlocked'
    | 'puttyLocked'
    | 'puttyUnencrypted'
    | 'puttyInAgent'
    | 'puttyNoAgent';
}
