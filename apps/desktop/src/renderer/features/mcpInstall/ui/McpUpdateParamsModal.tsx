/**
 * Minimal prompt shown before updating one or more installed MCP instances,
 * when the new source def introduces `{param}` placeholders that are absent
 * from every affected instance's OWN stored `.skmcp.params.yml` values (see
 * the design doc "MCP support" section 5, "Update"). Only the MISSING param
 * names ever reach the renderer -- never any stored value -- so this modal
 * asks for exactly those names and nothing else (no project/agent pickers:
 * those are already fixed by the instances being updated).
 *
 * The controls are the install modal's, for the same reason they are there: a
 * parameter with `options` renders as a `Select`, its description renders
 * above it, and Confirm is gated on `paramValueValid` rather than on
 * non-blankness. Without that, a user could type a value outside the option
 * set here, have the backend refuse it, and read an error about their own
 * input as if it were about something stored.
 *
 * Closing without every missing param filled in ABORTS the update: `onClose`
 * never receives the partially-filled values, only `onConfirm` does, and
 * Confirm stays disabled until every field holds an acceptable value.
 */
import { useEffect, useState } from 'react';
import type { McpPreset } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { DescriptionSpan } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, TextField, Select, DescriptionText } from '@/shared/ui';
import { descriptionQueries, spansForParam } from '../lib/descriptionSpanQueries';
import { paramValueValid } from '../lib/paramValueValid';
import './McpInstallModal.scss';

export interface McpUpdateParamsModalProps {
  readonly open: boolean;
  /** The preset being updated to, whose `def.parameters` carries each
   *  parameter's description and its accepted `options`. */
  readonly preset: McpPreset;
  /** Sorted, de-duplicated param names the update needs that are not yet stored. */
  readonly missingParams: readonly string[];
  /** Receives the filled-in values, keyed by param name, when Confirm is pressed. */
  readonly onConfirm: (values: Record<string, string>) => void;
  readonly onClose: () => void;
  /**
   * Fetches parsed description spans for the server and its parameters, in
   * the order `descriptionQueries` produces them. Defaults to
   * `bridgeClient.mcpDescriptionSpans`; a seam for stories/tests, since the
   * real bridge command is unavailable outside Tauri.
   */
  readonly getDescriptionSpans?: (descriptions: string[]) => Promise<DescriptionSpan[][]>;
}

export function McpUpdateParamsModal({
  open,
  preset,
  missingParams,
  onConfirm,
  onClose,
  getDescriptionSpans = bridgeClient.mcpDescriptionSpans,
}: McpUpdateParamsModalProps) {
  const t = useTranslator();
  const [values, setValues] = useState<Record<string, string>>({});
  // Populated once per open by a single `mcp_description_spans` call, exactly
  // as in `McpInstallModal`; empty until it resolves, which renders as "no
  // description" the same way "none authored" does.
  const [descriptionSpans, setDescriptionSpans] = useState<DescriptionSpan[][]>([]);

  // Reset the draft every time the modal opens, mirroring McpInstallModal.
  useEffect(() => {
    if (!open) return undefined;
    const seeded: Record<string, string> = {};
    for (const param of missingParams) seeded[param] = '';
    setValues(seeded);
    setDescriptionSpans([]);
    // Alive-flag guard, as in `McpInstallModal`: open A, close, open B before
    // A's spans resolve must not land A's descriptions on B's parameters.
    let alive = true;
    void getDescriptionSpans(descriptionQueries(preset))
      .then((spans) => {
        if (alive) setDescriptionSpans(spans);
      })
      .catch(() => {
        // Best-effort: a failed fetch leaves every description unrendered,
        // exactly like "none authored".
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Hands a link span's own `url` to the backend opener; never called with
   *  anything else (see `DescriptionText`'s doc comment). */
  function openLink(url: string): void {
    void bridgeClient.openExternalUrl(url);
  }

  const allFilled = missingParams.every((param) =>
    paramValueValid(preset.def.parameters[param], values[param] ?? ''),
  );

  function confirm(): void {
    if (!allFilled) return;
    onConfirm(values);
  }

  return (
    <Modal open={open} onClose={onClose} title={t('mcp.update')} className="sk-mcp-install">
      <div className="sk-mcp-install__form">
        <div className="sk-mcp-install__params">
          <span className="sk-mcp-install__label">{t('mcp.field.parameters')}</span>
          {missingParams.map((param) => {
            const meta = preset.def.parameters[param];
            const options = meta?.options ?? [];
            const paramSpans = spansForParam(preset, descriptionSpans, param);
            const value = values[param] ?? '';
            return (
              <label className="sk-mcp-install__field" key={param}>
                <span className="sk-mcp-install__param-label">{param}</span>
                {paramSpans !== undefined && (
                  <DescriptionText spans={paramSpans} onOpenLink={openLink} className="sk-mcp-install__param-help" />
                )}
                {options.length > 0 ? (
                  <>
                    <Select
                      options={options.map((o) => ({ value: o.value, label: o.label }))}
                      value={value}
                      onChange={(next) => setValues((v) => ({ ...v, [param]: next }))}
                      placeholder={t('mcp.param.choosePlaceholder')}
                      ariaLabel={param}
                    />
                    {!paramValueValid(meta, value) && (
                      <span className="sk-mcp-install__param-help">{t('mcp.error.invalidOption')}</span>
                    )}
                  </>
                ) : (
                  <TextField
                    value={value}
                    onChange={(e) => {
                      const next = e.target.value;
                      setValues((v) => ({ ...v, [param]: next }));
                    }}
                  />
                )}
              </label>
            );
          })}
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
