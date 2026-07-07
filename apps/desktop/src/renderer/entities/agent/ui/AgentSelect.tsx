/**
 * AgentSelect: a compact control for picking which agents an operation targets.
 * The trigger shows a robot glyph plus a small grey circle with the count of
 * selected agents; clicking opens a multi-select dropdown of all agents.
 */
import { useRef, useState } from 'react';
import { Menu, Icon, Tooltip } from '@/shared/ui';
import type { MenuItem } from '@/shared/ui';
import { ALL_AGENTS, AGENT_LABELS } from '@/domain';
import type { AgentKind } from '@/services/bridge';
import './AgentSelect.scss';

export interface AgentSelectProps {
  readonly value: readonly AgentKind[];
  readonly onChange: (next: AgentKind[]) => void;
  readonly ariaLabel: string;
  /**
   * `compact` (default): a robot glyph + a count circle -- for tight spots like
   * a TreeView row. `full`: a wider trigger listing the selected agent labels,
   * like a multi-select.
   */
  readonly variant?: 'compact' | 'full';
  /** Placeholder for the `full` variant when nothing is selected. */
  readonly placeholder?: string;
  /** When set, a tooltip is shown on the trigger (hidden while the menu is open). */
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function AgentSelect({
  value,
  onChange,
  ariaLabel,
  variant = 'compact',
  placeholder,
  tooltip,
  disabled,
  className,
}: AgentSelectProps) {
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

  const joined = value.map((a) => AGENT_LABELS[a]).join(', ');

  const trigger = (
    <button
      ref={anchorRef}
      type="button"
      className={variant === 'full' ? 'sk-agent-select sk-agent-select--full' : 'sk-agent-select'}
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
      {variant === 'full' ? (
        <>
          <span className="sk-agent-select__value">{value.length > 0 ? joined : placeholder}</span>
          <Icon name="chevron-right" className="sk-agent-select__chevron" size={16} />
        </>
      ) : (
        <span className="sk-agent-select__count" aria-hidden="true">
          {value.length}
        </span>
      )}
    </button>
  );

  return (
    // Stop click propagation: the Menu renders in a portal, but React events
    // bubble up the component tree, so a menu-item click would otherwise reach a
    // surrounding TreeView row and toggle it.
    <span className={className} onClick={(e) => e.stopPropagation()}>
      {tooltip !== undefined ? (
        // Hidden while the menu is open so the bubble never covers the dropdown.
        <Tooltip content={tooltip} disabled={open}>
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
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
