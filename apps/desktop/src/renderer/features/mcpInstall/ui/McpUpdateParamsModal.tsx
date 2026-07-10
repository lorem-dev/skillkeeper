/**
 * Minimal prompt shown before updating one or more installed MCP instances,
 * when the new source def introduces `{param}` placeholders that are absent
 * from every affected instance's OWN stored `.skmcp.params.yml` values (see
 * the design doc "MCP support" section 5, "Update"). Only the MISSING param
 * names ever reach the renderer -- never any stored value -- so this modal
 * asks for exactly those names and nothing else (no project/agent pickers:
 * those are already fixed by the instances being updated).
 *
 * Closing without every missing param filled in ABORTS the update: `onClose`
 * never receives the partially-filled values, only `onConfirm` does, and
 * Confirm stays disabled until every field is non-blank.
 */
import { useEffect, useState } from 'react';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, TextField } from '@/shared/ui';
import './McpInstallModal.scss';

export interface McpUpdateParamsModalProps {
  readonly open: boolean;
  /** Sorted, de-duplicated param names the update needs that are not yet stored. */
  readonly missingParams: readonly string[];
  /** Receives the filled-in values, keyed by param name, when Confirm is pressed. */
  readonly onConfirm: (values: Record<string, string>) => void;
  readonly onClose: () => void;
}

export function McpUpdateParamsModal({ open, missingParams, onConfirm, onClose }: McpUpdateParamsModalProps) {
  const t = useTranslator();
  const [values, setValues] = useState<Record<string, string>>({});

  // Reset the draft every time the modal opens, mirroring McpInstallModal.
  useEffect(() => {
    if (!open) return;
    const seeded: Record<string, string> = {};
    for (const param of missingParams) seeded[param] = '';
    setValues(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allFilled = missingParams.every((param) => (values[param] ?? '').trim() !== '');

  function confirm(): void {
    if (!allFilled) return;
    onConfirm(values);
  }

  return (
    <Modal open={open} onClose={onClose} title={t('mcp.update')} className="sk-mcp-install">
      <div className="sk-mcp-install__form">
        <div className="sk-mcp-install__params">
          <span className="sk-mcp-install__label">{t('mcp.field.parameters')}</span>
          {missingParams.map((param) => (
            <label className="sk-mcp-install__field" key={param}>
              <span className="sk-mcp-install__param-label">{param}</span>
              <TextField
                value={values[param] ?? ''}
                onChange={(e) => {
                  const next = e.target.value;
                  setValues((v) => ({ ...v, [param]: next }));
                }}
              />
            </label>
          ))}
        </div>
        <div className="sk-mcp-install__actions">
          <Button variant="secondary" onClick={onClose}>
            {t('mcp.cancel')}
          </Button>
          <Button variant="primary" disabled={!allFilled} onClick={confirm}>
            {t('mcp.update')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
