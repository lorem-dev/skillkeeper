/**
 * Components-page view switcher: tile grid vs. tree. A compact glass
 * `SplitButton` mirroring the config-editor control (`OpenConfigButton`): the
 * primary button shows the current view's glyph and toggles to the other view;
 * the dropdown lists both options explicitly. Presentational -- the page owns
 * the value (persisted in the `mcpUi` store slice) and the change handler.
 */
import { useTranslator } from '@/systems/i18n';
import { SplitButton, Icon } from '@/shared/ui';
import type { McpComponentsView } from '@/app/store';

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
    <SplitButton
      size="compact"
      glass
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
  );
}
