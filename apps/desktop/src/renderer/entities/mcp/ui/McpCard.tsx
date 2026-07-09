/**
 * McpCard: one MCP server preset (manual or repo-sourced) on the MCP page.
 * Purely presentational -- see the design doc "MCP support", section 7.
 * Mirrors RepositoryCard/ProjectCard for structure, truncation, and the
 * copy-button/badge conventions.
 */
import { Badge, Card, Button, Icon, Tooltip } from '@/shared/ui';
import './McpCard.scss';

export type McpProtocol = 'stdio' | 'http' | 'sse';

export interface McpCardProps {
  /** Preset name, shown as the card title. */
  readonly name: string;
  /** Source repository name (repo presets only); truncated to 25 chars. */
  readonly repoName?: string;
  /** Tooltip for the repo badge (e.g. "Go to repository"). */
  readonly goToRepoLabel?: string;
  /** Called when the repo badge is clicked. */
  readonly onGoToRepo?: () => void;
  /** Transport kind; drives which connection line (url vs command) applies. */
  readonly protocol: McpProtocol;
  /** Already-translated protocol label, e.g. "stdio". */
  readonly protocolLabel: string;
  /** Whether the preset ships guidance ("rules"). */
  readonly hasRules: boolean;
  /** Already-translated rules-badge label, e.g. "rules". */
  readonly rulesLabel: string;
  /** Server URL (http/sse). Mutually exclusive with `command`. */
  readonly url?: string;
  /** Full command string, including args (stdio). Mutually exclusive with `url`. */
  readonly command?: string;
  /** Tooltip for the url/command copy control (e.g. "Copy"). */
  readonly copyLabel?: string;
  /** Called when the url connection line is clicked (copies the url). */
  readonly onCopyUrl?: () => void;
  /** Called when the command connection line is clicked (copies the command). */
  readonly onCopyCommand?: () => void;
  /** Edit the preset (manual presets only); the edit button shows only when set. */
  readonly onEdit?: () => void;
  /** Tooltip/label for the edit button. */
  readonly editLabel: string;
  readonly onInstall: () => void;
  readonly installLabel: string;
}

/** Longest repo name shown on the badge before it is truncated with "...". */
const REPO_MAX = 25;
/** Hard cap on the url/command string length (CSS also ellipsizes to the card). */
const CONN_MAX = 80;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function McpCard({
  name,
  repoName,
  goToRepoLabel,
  onGoToRepo,
  protocol,
  protocolLabel,
  hasRules,
  rulesLabel,
  url,
  command,
  copyLabel,
  onCopyUrl,
  onCopyCommand,
  onEdit,
  editLabel,
  onInstall,
  installLabel,
}: McpCardProps) {
  return (
    <Card className="sk-mcp-card" data-protocol={protocol}>
      <div className="sk-mcp-card__main">
        <span className="sk-mcp-card__name-row">
          <span className="sk-mcp-card__name">{name}</span>
        </span>
        {/* Connection line: exactly one of url (http/sse) or command (stdio) is
            shown, mirroring RepositoryCard's clickable remote-URL button. */}
        {url !== undefined ? (
          <Tooltip content={copyLabel ?? ''} className="sk-mcp-card__conn-tip">
            <button
              type="button"
              className="sk-mcp-card__url sk-mcp-card__url--button"
              onClick={onCopyUrl}
              aria-label={copyLabel}
            >
              {truncate(url, CONN_MAX)}
            </button>
          </Tooltip>
        ) : (
          command !== undefined && (
            <Tooltip content={copyLabel ?? ''} className="sk-mcp-card__conn-tip">
              <button
                type="button"
                className="sk-mcp-card__command sk-mcp-card__command--button"
                onClick={onCopyCommand}
                aria-label={copyLabel}
              >
                <pre className="sk-mcp-card__command-pre">{truncate(command, CONN_MAX)}</pre>
              </button>
            </Tooltip>
          )
        )}
        <span className="sk-mcp-card__badges">
          {repoName !== undefined && (
            <Tooltip content={goToRepoLabel ?? ''}>
              <button
                type="button"
                className="sk-mcp-card__repo-badge"
                onClick={onGoToRepo}
                aria-label={goToRepoLabel}
              >
                <Badge tone="accent">{truncate(repoName, REPO_MAX)}</Badge>
              </button>
            </Tooltip>
          )}
          <Badge tone="neutral">{protocolLabel}</Badge>
          {hasRules && <Badge tone="neutral">{rulesLabel}</Badge>}
        </span>
      </div>
      <div className="sk-mcp-card__actions">
        {onEdit !== undefined && (
          <Tooltip content={editLabel}>
            <Button
              variant="secondary"
              glass
              className="sk-mcp-card__icon-btn"
              onClick={onEdit}
              aria-label={editLabel}
            >
              <Icon name="edit" />
            </Button>
          </Tooltip>
        )}
        <Button variant="primary" onClick={onInstall}>
          {installLabel}
        </Button>
      </div>
    </Card>
  );
}
