export { McpInstallModal } from './ui/McpInstallModal';
export type { McpInstallModalProps } from './ui/McpInstallModal';
export { McpUpdateParamsModal } from './ui/McpUpdateParamsModal';
export type { McpUpdateParamsModalProps } from './ui/McpUpdateParamsModal';
export { supportsTransport } from './lib/supportsTransport';
export { supportsOauth } from './lib/supportsOauth';
export { buildInstallBatches, buildRemoveBatches } from './lib/buildBatches';
// Exported because every surface that applies an MCP batch has to report what
// the backend declined and what a writer dropped -- the install modal, the
// update flow in `pages/Mcp/useMcpActions`, and the skill-save modal. Three
// copies of that mapping is how the update flow ended up reporting neither.
export { installNotesToMessages } from './lib/installNotesToMessages';
export { mcpSkipsToMessages } from './lib/mcpSkipsToMessages';
// Exported for the same reason: every surface that ASKS for a parameter value
// has to accept the same values the backend does. The skill-save modal is the
// third such surface, and it was the one that had neither the option select
// nor this predicate.
export { paramValueValid } from './lib/paramValueValid';
export { descriptionQueries, spansForParam } from './lib/descriptionSpanQueries';
