/**
 * Domain model for SkillKeeper core.
 *
 * These are plain, framework-agnostic TypeScript types shared across every
 * package. This module contains type declarations only (no runtime logic), so
 * it is excluded from the coverage gate.
 */

/** Supported AI coding agents. Extended by adding a new adapter module. */
export type AgentKind = 'claude' | 'codex' | 'copilot' | 'cursor' | 'opencode';

/** Stable identity of a skill: an optional one-level group plus a name. */
export interface SkillId {
  readonly group?: string;
  readonly name: string;
}

/**
 * How a hook applies its edit to an agent's configuration.
 *
 * - `delimited-text`: a comment-delimited region in a comment-capable file.
 * - `json-merge`: a node merged into a JSON config (for example Claude
 *   `settings.json` under `hooks`), tagged with an ownership marker.
 * - `file`: a hook-owned standalone file.
 */
export type HookStrategy = 'delimited-text' | 'json-merge' | 'file';

/**
 * Parsed `SKILL.md` frontmatter. The Markdown body is documentation and is not
 * part of this record.
 */
export interface SkillManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly license?: string;
  /**
   * Relative paths (within the skill body) that must be marked executable
   * after install. Globs are matched separately via configuration.
   */
  readonly executables?: readonly string[];
  /** Names of hooks declared by this skill (each maps to a `hooks/<name>`). */
  readonly hooks?: readonly string[];
}

/**
 * Where a hook writes its edit: an agent, plus either a file pattern (for
 * text/file strategies) or a config key path (for json-merge).
 */
export interface HookTarget {
  readonly agent: AgentKind;
  /** Glob or relative path of the file to edit (text and file strategies). */
  readonly filePattern?: string;
  /** Dotted key path inside a JSON config (json-merge strategy). */
  readonly keyPath?: string;
}

/** Parsed `HOOK.md` frontmatter. */
export interface HookManifest {
  readonly name: string;
  readonly target: HookTarget;
  readonly strategy: HookStrategy;
  readonly version?: string;
  readonly description?: string;
}

/** A hook discovered alongside a skill in a working tree. */
export interface ResolvedHook {
  readonly manifest: HookManifest;
  /** Path to `hooks/<name>/HOOK.md` relative to the repo root. */
  readonly manifestPath: string;
  /** All hook file paths (including HOOK.md) relative to the repo root. */
  readonly files: readonly string[];
}

/** A skill discovered in a checked-out working tree. */
export interface ResolvedSkill {
  readonly id: SkillId;
  /** Directory containing SKILL.md, relative to the repo root. */
  readonly rootPath: string;
  readonly manifest: SkillManifest;
  /**
   * Skill body file paths relative to the repo root, excluding everything under
   * `hooks/`. Sorted for stable ordering.
   */
  readonly files: readonly string[];
  readonly hooks: readonly ResolvedHook[];
}

/** A Git remote that holds one or more skills. */
export interface Repository {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly kind: 'github' | 'bitbucket' | 'generic';
  readonly transport: 'ssh' | 'https';
  readonly lfs: boolean;
  readonly localPath: string;
  readonly lastFetched?: string;
  /** User-selected branch to track; the repo is force-checked-out to it and
   * updates apply it. Absent means the clone's default branch. */
  readonly branch?: string;
}

/** A concrete (agent, scope) destination for an install. */
export interface AgentTarget {
  readonly agent: AgentKind;
  readonly scope: 'project' | 'global';
  /** Identifies the tracked project when scope is `project`. */
  readonly projectId?: string;
}

/** A single managed file recorded in an install manifest. */
export interface ManagedFile {
  /** Path relative to the install destination root. */
  readonly relPath: string;
  readonly sha256: string;
  readonly executable: boolean;
}

/**
 * One applied hook edit, recorded so it can be verified and removed precisely.
 * Tagged union discriminated by `kind`.
 */
export type ManagedHookEdit =
  | {
      readonly kind: 'delimited';
      /** Path of the edited text file, relative to the destination root. */
      readonly file: string;
      readonly delimiterId: string;
      readonly sha256: string;
    }
  | {
      readonly kind: 'json';
      /** Path of the edited JSON file, relative to the destination root. */
      readonly file: string;
      /** Dotted key path of the array the node was merged into. */
      readonly keyPath: string;
      readonly markerId: string;
      readonly sha256: string;
    }
  | {
      readonly kind: 'file';
      readonly relPath: string;
      readonly sha256: string;
      readonly executable: boolean;
    };

/** The record of one installed skill at one agent target. */
export interface InstallManifest {
  readonly skillId: SkillId;
  readonly target: AgentTarget;
  /** Absolute destination root the files live under. */
  readonly destinationRoot: string;
  /** Source repository id, when installed from a repository. */
  readonly sourceRepoId?: string;
  /** Source local path, when installed from a working tree. */
  readonly sourcePath?: string;
  readonly version?: string;
  /** ISO-8601 install timestamp. */
  readonly installedAt: string;
  readonly files: readonly ManagedFile[];
  readonly hookEdits: readonly ManagedHookEdit[];
}

/** A tracked project directory. */
export interface Project {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /** ISO-8601 timestamp. */
  readonly addedAt: string;
}
