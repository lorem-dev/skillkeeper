/**
 * Pure builder for `ApplyMcpArgs.batches`: given a preset the user picked, the
 * agents they checked, and the parameter values they filled in, produces one
 * `McpBatch` per agent -- each carrying a single install request and no
 * removes (this is the fresh-install path; see design spec "MCP support"
 * section 5 "Install (per selected agent target)" and section 8 "Install
 * modal"). The identity mirrors the `.skmcp.yml` matching rule from section 1
 * ("Ledger files"): repo presets key on `(remote, group, source)`, manual
 * presets key on `(local, source)`.
 */
import type { AgentKind, McpBatch, McpIdentity, McpInstall } from '@/services/bridge';
import type { McpPreset } from '@/app/store';

function identityFor(preset: McpPreset): McpIdentity {
  if (preset.origin === 'repo') {
    return {
      ...(preset.remote !== undefined ? { remote: preset.remote } : {}),
      ...(preset.group !== undefined ? { group: preset.group } : {}),
      source: preset.name,
    };
  }
  return { local: preset.id, source: preset.name };
}

/**
 * Builds one install batch per selected agent for `preset`, rendering
 * `values` into every batch's single install request. `remove` is always
 * empty -- this only ever produces fresh installs.
 */
export function buildInstallBatches(
  preset: McpPreset,
  agents: readonly AgentKind[],
  values: Record<string, string>,
): McpBatch[] {
  const identity = identityFor(preset);
  return agents.map((agent) => ({
    agent,
    install: [{ identity, def: preset.def, values }],
    remove: [],
  }));
}

/**
 * Builds one remove batch per installed instance -- each `McpBatch` carries a
 * single remove request (by `instanceName`) and no installs. Used by the MCP
 * tree page's Delete action on an installed/unlinked leaf, mirroring the
 * per-instance remove batch the store's `deleteMcpPreset` builds inline for
 * its own manual-preset cascade.
 */
export function buildRemoveBatches(installs: readonly McpInstall[]): McpBatch[] {
  return installs.map((inst) => ({ agent: inst.agent, install: [], remove: [{ instanceName: inst.instanceName }] }));
}
