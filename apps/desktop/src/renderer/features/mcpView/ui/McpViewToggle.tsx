/**
 * Components-page view switcher: tile grid vs. tree. A compact, non-glass
 * SEGMENTED control (two icon buttons, the active one highlighted) with a field
 * label above it -- no dropdown/popup. Sits in the page's filters row, laid out
 * like the neighbouring `Select` fields (label + control). Presentational: the
 * page owns the value (persisted in the `mcpUi` store slice) and the handler.
 */
import type { ReactNode } from 'react';
import { useTranslator } from '@/systems/i18n';
import { cx } from '@/shared/lib';
import { Icon, Tooltip } from '@/shared/ui';
import type { McpComponentsView } from '@/app/store';
import './McpViewToggle.scss';

export interface McpViewToggleProps {
  readonly value: McpComponentsView;
  readonly onChange: (value: McpComponentsView) => void;
}

export function McpViewToggle({ value, onChange }: McpViewToggleProps) {
  const t = useTranslator();
  const label = t('mcp.view.label');

  function segment(view: McpComponentsView, glyph: 'view-tiles' | 'view-tree', name: string): ReactNode {
    return (
      <Tooltip content={name}>
        <button
          type="button"
          className={cx('sk-mcp-view__btn', value === view && 'sk-mcp-view__btn--active')}
          aria-pressed={value === view}
          aria-label={name}
          onClick={() => onChange(view)}
        >
          <Icon name={glyph} size={18} />
        </button>
      </Tooltip>
    );
  }

  return (
    <span className="sk-mcp-view">
      <span className="sk-mcp-view__label">{label}</span>
      <div className="sk-mcp-view__control" role="group" aria-label={label}>
        {segment('tiles', 'view-tiles', t('mcp.view.tiles'))}
        {segment('tree', 'view-tree', t('mcp.view.tree'))}
      </div>
    </span>
  );
}
