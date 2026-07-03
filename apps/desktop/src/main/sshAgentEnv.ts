/**
 * Parse `ssh-agent -s` stdout into the env values we need. Pure -- imports
 * nothing from electron or the Node runtime -- so it is unit-testable under
 * vitest's node environment. ssh-agent prints lines like:
 *   SSH_AUTH_SOCK=/tmp/ssh-abc/agent.42; export SSH_AUTH_SOCK;
 *   SSH_AGENT_PID=43; export SSH_AGENT_PID;
 */
export interface AgentEnv {
  readonly sock?: string;
  readonly pid?: string;
}

export function parseAgentEnv(stdout: string): AgentEnv {
  const sock = /SSH_AUTH_SOCK=([^;\s]+)/.exec(stdout)?.[1];
  const pid = /SSH_AGENT_PID=([^;\s]+)/.exec(stdout)?.[1];
  return {
    ...(sock !== undefined ? { sock } : {}),
    ...(pid !== undefined ? { pid } : {}),
  };
}
