/**
 * Confirmation prompt shown before updating one or more installed MCP
 * instances to their preset's current source def.
 *
 * The preflight (`onPreflight`) does NOT run when this modal opens -- it runs
 * only when Confirm is first pressed (see `handleSubmit`'s `'confirm'` branch
 * below). This is what the 0.7.0 fix ("Updating an MCP server no longer
 * deletes it when the new definition cannot be installed") depends on being
 * testable end to end: an update whose new def the agent's native config
 * cannot express (an inexpressible transport, or a placeholder with no value)
 * must show its refusal HERE, before `onConfirm` -- and therefore before the
 * mutating `updateMcp` call -- ever runs, rather than as a toast that could
 * fire after a partial removal. Confirm doubles as that trigger and, once the
 * preflight has resolved, as the actual confirm button:
 *
 *   - refused (`ok: false`): shows the refusal inline (`error`, phase
 *     `'error'`) and stops -- `onConfirm` is never called, so the caller's
 *     `runMcpUpdate` (which is what calls `updateMcp`) never runs either.
 *   - accepted, nothing missing (`missingParams` empty): calls `onConfirm({})`
 *     immediately -- no fields to ask for.
 *   - accepted, something missing: shows exactly those fields (phase
 *     `'params'`) and waits for a second Confirm press.
 *
 * Only the MISSING param names ever reach the renderer -- never any stored
 * value -- so the `'params'` phase asks for exactly those names and nothing
 * else (no project/agent pickers: those are already fixed by the instances
 * being updated).
 *
 * The controls are the install modal's, for the same reason they are there: a
 * parameter with `options` renders as a `Select`, its description renders
 * above it, and Confirm is gated on `paramValueValid` rather than on
 * non-blankness. Without that, a user could type a value outside the option
 * set here, have the backend refuse it, and read an error about their own
 * input as if it were about something stored.
 *
 * Closing without confirming ABORTS the update at any phase: `onClose` never
 * receives a value and `onConfirm` is never called unless Confirm itself
 * calls it.
 */
import { useEffect, useState } from 'react';
import type { McpPreset } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { DescriptionSpan, McpUpdatePreflightResult } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, TextField, Select, DescriptionText } from '@/shared/ui';
import { descriptionQueries, spansForParam } from '../lib/descriptionSpanQueries';
import { paramValueValid } from '../lib/paramValueValid';
import './McpInstallModal.scss';

/** Where the modal is in its confirm -> preflight -> (params ->) confirm
 *  sequence. Reset to `'confirm'` every time the modal opens. */
type Phase = 'confirm' | 'checking' | 'params' | 'error';

export interface McpUpdateParamsModalProps {
  readonly open: boolean;
  /** The preset being updated to, whose `def.parameters` carries each
   *  parameter's description and its accepted `options`. */
  readonly preset: McpPreset;
  /**
   * Runs the preflight for every instance this update affects. Called once,
   * the first time Confirm is pressed -- never on open, so a modal that is
   * opened and immediately closed never reaches the backend.
   */
  readonly onPreflight: () => Promise<McpUpdatePreflightResult>;
  /** Receives the filled-in values (keyed by param name; empty when nothing
   *  was missing) once the preflight has accepted the update and every
   *  required field holds an acceptable value. */
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
  onPreflight,
  onConfirm,
  onClose,
  getDescriptionSpans = bridgeClient.mcpDescriptionSpans,
}: McpUpdateParamsModalProps) {
  const t = useTranslator();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [missingParams, setMissingParams] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  // Populated once per open by a single `mcp_description_spans` call, exactly
  // as in `McpInstallModal`; empty until it resolves, which renders as "no
  // description" the same way "none authored" does.
  const [descriptionSpans, setDescriptionSpans] = useState<DescriptionSpan[][]>([]);

  // Reset every time the modal opens, mirroring McpInstallModal -- including
  // the phase, so reopening after an earlier refusal or a filled-in form
  // starts clean rather than replaying stale state.
  useEffect(() => {
    if (!open) return undefined;
    setPhase('confirm');
    setMissingParams([]);
    setError('');
    setValues({});
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

  const allFilled = missingParams.every((param) => paramValueValid(preset.def.parameters[param], values[param] ?? ''));

  function handleSubmit(): void {
    if (phase === 'params') {
      if (!allFilled) return;
      onConfirm(values);
      return;
    }
    if (phase !== 'confirm') return;
    setPhase('checking');
    void onPreflight().then((result) => {
      if (!result.ok) {
        setError(result.error);
        setPhase('error');
        return;
      }
      if (result.missingParams.length === 0) {
        onConfirm({});
        return;
      }
      const seeded: Record<string, string> = {};
      for (const param of result.missingParams) seeded[param] = '';
      setValues(seeded);
      setMissingParams(result.missingParams);
      setPhase('params');
    });
  }

  const submitDisabled = phase === 'checking' || phase === 'error' || (phase === 'params' && !allFilled);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mcp.update')}
      className="sk-mcp-install"
      data-testid="mcp-update-modal"
    >
      <div className="sk-mcp-install__form">
        {phase === 'params' && (
          <div className="sk-mcp-install__params">
            <span className="sk-mcp-install__label">{t('mcp.field.parameters')}</span>
            {missingParams.map((param) => {
              const meta = preset.def.parameters[param];
              const options = meta?.options ?? [];
              const paramSpans = spansForParam(preset, descriptionSpans, param);
              const value = values[param] ?? '';
              return (
                // e2e (flow 8, `mcp.spec.ts`): mirrors `McpInstallModal`'s
                // per-parameter row -- the field's kind (input or select) is
                // this row's own testid; `data-param-name` (on the child
                // label span, never this row itself) names which parameter.
                <label
                  className="sk-mcp-install__field"
                  key={param}
                  data-testid={options.length > 0 ? 'mcp-param-select' : 'mcp-param-input'}
                >
                  <span className="sk-mcp-install__param-label" data-param-name={param}>
                    {param}
                  </span>
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
        )}
        {phase === 'error' && (
          <p className="sk-mcp-install__error" role="alert" data-testid="mcp-update-error">
            {error}
          </p>
        )}
        <div className="sk-mcp-install__actions">
          <Button variant="secondary" onClick={onClose}>
            {t('mcp.cancel')}
          </Button>
          <Button variant="primary" disabled={submitDisabled} onClick={handleSubmit} data-testid="mcp-update-submit">
            {t('mcp.update')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
