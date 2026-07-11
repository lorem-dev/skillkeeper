/**
 * Components-page view switcher: tile grid vs. tree. The same compact
 * `SplitButton` control as elsewhere, but NON-glass and narrow, with a field
 * label above it so it lines up with the neighbouring filter controls. The
 * primary button shows the current view's glyph and toggles to the other; the
 * dropdown lists both options. Presentational -- the page owns the value
 * (persisted in the `mcpUi` store slice) and the change handler.
 */
import { useTranslator } from '@/systems/i18n';
import { SplitButton, Icon } from '@/shared/ui';
import type { McpComponentsView } from '@/app/store';
import './McpViewToggle.scss';

export interface McpViewToggleProps {
  readonly value: McpComponentsView;
  readonly onChange: (value: McpComponentsView) => void;
}

const GLYPH: Record<McpComponentsView, 'view-tiles' | 'view-tree'> = {
  tiles: 'view-tiles',
  tree: 'view-tree',
};

export function McpViewToggle({ value, onChange }: McpViewToggleProps) {
  const t = useTranslator();
  const label = t('mcp.view.label');
  return (
    <span className="sk-mcp-view">
      <span className="sk-mcp-view__label">{label}</span>
      <SplitButton
        size="compact"
        icon={<Icon name={GLYPH[value]} />}
        tooltip={label}
        menuLabel={label}
        onPrimary={() => onChange(value === 'tiles' ? 'tree' : 'tiles')}
        items={[
          {
            id: 'tiles',
            label: t('mcp.view.tiles'),
            icon: <Icon name="view-tiles" />,
            onSelect: () => onChange('tiles'),
          },
          {
            id: 'tree',
            label: t('mcp.view.tree'),
            icon: <Icon name="view-tree" />,
            onSelect: () => onChange('tree'),
          },
        ]}
      />
    </span>
  );
}
