import type { AgentKind } from '@/services/bridge';

/** Display labels for agent kinds. Proper nouns -- identical in every locale. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

/** All known agent kinds in a stable order. */
export const ALL_AGENTS: readonly AgentKind[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
];
