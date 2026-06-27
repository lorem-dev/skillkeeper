/**
 * Small factory shared by the non-reference adapters. Each agent supplies only
 * its own path logic and hook capability; everything that is identical across
 * agents (skill-directory discovery, availability probe) lives here once.
 *
 * The design goal from the spec is that, when an agent's real on-disk layout is
 * confirmed, ONLY that agent's `skillsRoot`, `markerDir`, and `hook` values need
 * to change -- never the consumers and never this factory.
 */

import type {
  AgentAdapter,
  AgentKind,
  AgentTarget,
  DiscoveredSkill,
  HookCapability,
  HostEnv,
} from '@skillkeeper/core';
import { discoverSkillDirs, fsOf } from './paths.js';

/** Per-agent configuration consumed by {@link makeAdapter}. */
export interface AdapterSpec {
  readonly kind: AgentKind;
  /** Absolute skills root for a target (project or global scope). */
  skillsRoot(target: AgentTarget, env: HostEnv): string;
  /**
   * A directory whose presence indicates the agent is configured for the user.
   * Probed at global scope by {@link AgentAdapter.isAvailable}.
   */
  availabilityDir(env: HostEnv): string;
  /**
   * Optional group label attached to every discovered skill, for agents that
   * nest skills one level under a group directory. Most agents leave this off.
   */
  readonly discoveryGroup?: string;
  /** The agent's hook capability. */
  readonly hook: HookCapability;
}

/** Build an {@link AgentAdapter} from a per-agent {@link AdapterSpec}. */
export function makeAdapter(spec: AdapterSpec): AgentAdapter {
  return {
    kind: spec.kind,

    async isAvailable(env: HostEnv): Promise<boolean> {
      return fsOf(env).exists(spec.availabilityDir(env));
    },

    async destinationRoot(target: AgentTarget, env: HostEnv): Promise<string> {
      return spec.skillsRoot(target, env);
    },

    async discoverInstalled(target: AgentTarget, env: HostEnv): Promise<DiscoveredSkill[]> {
      return discoverSkillDirs(fsOf(env), spec.skillsRoot(target, env), spec.discoveryGroup);
    },

    hookSupport: spec.hook,
  };
}
