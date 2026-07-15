/**
 * Agent adapter interface. The install engine drives every agent through this
 * interface, so it never imports a concrete agent. Implementations live in the
 * `@skillkeeper/agents` package and register themselves. This module declares
 * interfaces only and is excluded from the coverage gate.
 */

import type { AgentKind, AgentTarget, HookStrategy } from './model.js';
import type { HostEnv } from './ports.js';

/** A skill discovered in an agent location that SkillKeeper did not install. */
export interface DiscoveredSkill {
  /** Skill directory name (the immediate folder under the skills root). */
  readonly name: string;
  /** Absolute path to the discovered skill directory. */
  readonly path: string;
  /** Group folder name when the agent nests skills one level, if any. */
  readonly group?: string;
}

/**
 * Declares how an agent accepts hooks. Present only when the agent supports
 * hooks. This is what lets one install engine drive hooks for every agent
 * regardless of the on-disk file format.
 */
export interface HookCapability {
  readonly strategy: HookStrategy;
  /** Resolve the config file a hook edits for a given target. */
  resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string>;
  /** Comment token for the `delimited-text` strategy (for example `#`). */
  readonly commentToken?: string;
  /** Closing comment token for languages that need one (for example `-->`). */
  readonly commentClose?: string;
}

/** Adapter for one supported AI coding agent. */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** True when the agent appears installed/usable in the host environment. */
  isAvailable(env: HostEnv): Promise<boolean>;
  /** Absolute destination root for skills at the given target. */
  destinationRoot(target: AgentTarget, env: HostEnv): Promise<string>;
  /** Absolute path of the agent's guidance file (CLAUDE.md, AGENTS.md, ...) for
   *  the target. Where GUIDE.md / RULES.md block content is written. */
  guidanceFile(target: AgentTarget, env: HostEnv): Promise<string>;
  /** Skills already present in the agent's locations (external discovery). */
  discoverInstalled(target: AgentTarget, env: HostEnv): Promise<DiscoveredSkill[]>;
  /** Hook support, or undefined when the agent has no hooks. */
  readonly hookSupport?: HookCapability;
}
