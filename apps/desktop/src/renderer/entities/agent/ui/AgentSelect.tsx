/**
 * AgentSelect: a compact control for picking which agents an operation targets.
 * The trigger shows a robot glyph plus a small grey circle with the count of
 * selected agents; clicking opens a multi-select dropdown of all agents.
 */
import { useRef, useState } from 'react';
import { Menu, Icon } from '@/shared/ui';
import type { MenuItem } from '@/shared/ui';
import { ALL_AGENTS, AGENT_LABELS } from '@/domain';
import type { AgentKind } from '@/services/bridge';
import './AgentSelect.scss';

export interface AgentSelectProps {
  readonly value: readonly AgentKind[];
  readonly onChange: (next: AgentKind[]) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function AgentSelect({ value, onChange, ariaLabel, disabled, className }: AgentSelectProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const toggle = (agent: AgentKind): void =>
    onChange(value.includes(agent) ? value.filter((a) => a !== agent) : [...value, agent]);

  const items: MenuItem[] = ALL_AGENTS.map((agent) => ({
    id: agent,
    label: AGENT_LABELS[agent],
    selected: value.includes(agent),
    onSelect: () => toggle(agent),
  }));

  return (
    <span className={className}>
      <button
        ref={anchorRef}
        type="button"
        className="sk-agent-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        // Stop the click so a surrounding row (e.g. a TreeView row) does not also react.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="agent" size={18} />
        <span className="sk-agent-select__count" aria-hidden="true">
          {value.length}
        </span>
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        items={items}
        role="listbox"
        multiselectable
        closeOnSelect={false}
        ariaLabel={ariaLabel}
      />
    </span>
  );
}
