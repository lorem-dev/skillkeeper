/**
 * The install modal, the update prompt and the skill-save modal all read
 * `preset.def.parameters[param]` for every scanned placeholder, through the
 * two shared helpers exercised here.
 *
 * A def that arrives over the bridge does not always HAVE that map.
 * `McpServerDef.parameters` is `#[serde(skip_serializing_if =
 * "BTreeMap::is_empty")]` in Rust, so a preset with `{placeholder}`s and no
 * `parameters:` block -- which is every `mcp.yml` authored before that block
 * existed -- is sent as `{"name":"docs","type":"http","url":"https://{host}/docs"}`,
 * while the generated TypeScript declares `parameters` required. Indexing the
 * map on such a def throws `Cannot read properties of undefined`.
 *
 * Every other fixture in this feature builds its def in TypeScript with
 * `parameters` present, which is why the whole renderer suite passed over a
 * guaranteed crash on the primary install flow. The def below has NO
 * `parameters` key at all, and that absence is the scenario rather than a
 * fixture shortcut: no cast is needed for it only because
 * {@link RawMcpServerDef} now states the wire shape honestly, which is what
 * forces every inbound def through `normalizeMcpDefFromBridge` -- the single
 * boundary (in `refreshMcpPresets`) where the key is filled in.
 */
import { describe, it, expect } from 'vitest';
import { normalizeMcpDefFromBridge } from '@/app/store';
import type { McpPreset } from '@/app/store';
import type { RawMcpServerDef, McpServerDef } from '@/services/bridge';
import { descriptionQueries, spansForParam } from './descriptionSpanQueries';
import { paramValueValid } from './paramValueValid';

/** Exactly the JSON `mcp_list_available` sends for such a preset. */
const WIRE_DEF: RawMcpServerDef = {
  name: 'docs',
  type: 'http',
  url: 'https://{host}/docs',
};

/** The preset `refreshMcpPresets` builds from it. `params` is non-empty while
 *  the metadata map is absent -- it comes from the scanner reading `{host}`
 *  out of the url, not from `parameters` -- which is the combination that
 *  crashed: a reader indexes the map once per scanned param. */
function presetFromBridge(): McpPreset {
  return {
    id: 'repo:repo-1::docs',
    origin: 'repo',
    name: WIRE_DEF.name,
    def: normalizeMcpDefFromBridge(WIRE_DEF),
    hash: 'sha256:repo-hash',
    params: ['host'],
    hasRules: false,
  };
}

describe('a def sent without its parameters key', () => {
  it('throws when read unnormalized, and does not once normalized', () => {
    // The cast is what the renderer used to do implicitly by trusting the
    // generated type; it is here to show what that trust cost.
    const unnormalized = WIRE_DEF as McpServerDef;
    expect(() => unnormalized.parameters['host']).toThrow(TypeError);
    expect(() => normalizeMcpDefFromBridge(WIRE_DEF).parameters['host']).not.toThrow();
  });

  it('asks the description-span command for a slot per param, with nothing authored', () => {
    expect(descriptionQueries(presetFromBridge())).toEqual(['', '']);
  });

  it('reports no parameter description to render', () => {
    // Both slots come back empty from the backend, as they must for a def that
    // authored no descriptions at all.
    expect(spansForParam(presetFromBridge(), [[], []], 'host')).toBeUndefined();
  });

  it('gates the confirm button on non-blankness, as a parameter with no metadata should', () => {
    const preset = presetFromBridge();
    const meta = preset.def.parameters['host'];
    expect(paramValueValid(meta, '')).toBe(false);
    expect(paramValueValid(meta, 'docs.example.com')).toBe(true);
  });
});
