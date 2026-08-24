/**
 * Tests for the pure query-building/result-reading helpers that let
 * `McpInstallModal` call `mcp_description_spans` once per open and zip the
 * result back onto the server description and each parameter.
 */
import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { DescriptionSpan } from '@/services/bridge';
import { descriptionQueries, spansForServer, spansForParam } from './descriptionSpanQueries';

function preset(over: Partial<McpPreset['def']>, params: string[] = []): McpPreset {
  return {
    id: 'manual-1',
    origin: 'manual',
    name: 'github',
    def: { name: 'github', type: 'stdio', parameters: {}, ...over },
    hash: 'sha256:x',
    params,
    hasRules: false,
  };
}

function text(value: string): DescriptionSpan {
  return { kind: 'text', text: value };
}

describe('descriptionQueries', () => {
  it('puts the server description first, then each param in order, missing ones as empty strings', () => {
    const p = preset(
      {
        description: 'Server summary.',
        parameters: {
          region: { description: 'AWS region.', options: [] },
          token: { options: [] },
        },
      },
      ['region', 'token'],
    );
    expect(descriptionQueries(p)).toEqual(['Server summary.', 'AWS region.', '']);
  });

  it('uses an empty string for an absent server description', () => {
    const p = preset({ parameters: { region: { description: 'AWS region.', options: [] } } }, ['region']);
    expect(descriptionQueries(p)).toEqual(['', 'AWS region.']);
  });

  it('uses an empty string for a param with no metadata entry at all', () => {
    const p = preset({}, ['untracked']);
    expect(descriptionQueries(p)).toEqual(['', '']);
  });
});

describe('spansForServer', () => {
  it('returns the first result when the def has a description', () => {
    const p = preset({ description: 'Server summary.' });
    const results = [[text('Server summary.')], []];
    expect(spansForServer(p, results)).toEqual([text('Server summary.')]);
  });

  it('returns undefined when the def has no description, even if a result exists at index 0', () => {
    const p = preset({});
    const results = [[text('should not surface')]];
    expect(spansForServer(p, results)).toBeUndefined();
  });

  it('returns undefined for an authored-but-empty ("") description, which parses to an empty span list', () => {
    // description: '' is DEFINED (not absent) -- an mcp.yml can carry it, and
    // core never normalizes it away. It must render exactly like "no
    // description was authored", not as a visible-but-blank line.
    const p = preset({ description: '' });
    const results = [[]];
    expect(spansForServer(p, results)).toBeUndefined();
  });
});

describe('spansForParam', () => {
  it('returns the entry at params-order-plus-one when the param has a description', () => {
    const p = preset(
      {
        description: 'Server summary.',
        parameters: { region: { description: 'AWS region.', options: [] } },
      },
      ['region'],
    );
    const results = [[text('Server summary.')], [text('AWS region.')]];
    expect(spansForParam(p, results, 'region')).toEqual([text('AWS region.')]);
  });

  it('returns undefined for a param with no description', () => {
    const p = preset({ parameters: { region: { options: [] } } }, ['region']);
    const results = [[], []];
    expect(spansForParam(p, results, 'region')).toBeUndefined();
  });

  it('returns undefined for a param with no metadata entry at all', () => {
    const p = preset({}, ['untracked']);
    const results = [[], []];
    expect(spansForParam(p, results, 'untracked')).toBeUndefined();
  });

  it('locates the second of two described params by its own position, not the first', () => {
    const p = preset(
      {
        parameters: {
          region: { description: 'AWS region.', options: [] },
          zone: { description: 'AWS zone.', options: [] },
        },
      },
      ['region', 'zone'],
    );
    const results = [[], [text('AWS region.')], [text('AWS zone.')]];
    expect(spansForParam(p, results, 'zone')).toEqual([text('AWS zone.')]);
  });

  it('returns undefined for an authored-but-empty ("") param description', () => {
    const p = preset({ parameters: { region: { description: '', options: [] } } }, ['region']);
    const results = [[], []];
    expect(spansForParam(p, results, 'region')).toBeUndefined();
  });

  it('returns undefined, not the server description, for a param not in preset.params even when its stale metadata carries one (defensive: unreachable from the modal today)', () => {
    // `zzz` has a description in `parameters` but is absent from `params`
    // (stale authoring metadata for a placeholder that no longer exists).
    // `preset.params.indexOf('zzz')` is -1; naively adding 1 gives 0, which
    // would wrongly resolve to the SERVER's own spans at `results[0]`.
    const p = preset(
      {
        description: 'Server summary.',
        parameters: {
          region: { description: 'Region.', options: [] },
          zzz: { description: 'Stale, unreachable metadata.', options: [] },
        },
      },
      ['region', 'token'],
    );
    const results = [[text('Server summary.')], [text('Region.')]];
    expect(spansForParam(p, results, 'zzz')).toBeUndefined();
  });

  it('zips results by params ORDER, not by the parameters map key order, when they diverge', () => {
    const p = preset(
      {
        // This object's own key order is 'token' then 'region' -- the
        // REVERSE of `params` below. An implementation that zipped by
        // `Object.keys(parameters)` order instead of `preset.params` order
        // would read the wrong entry back for both params.
        parameters: {
          token: { description: 'Token description.', options: [] },
          region: { description: 'Region description.', options: [] },
        },
      },
      ['region', 'token'],
    );
    const results = [
      [], // index 0: server (none authored here)
      [text('Region description.')], // index 1: region, per params[0]
      [text('Token description.')], // index 2: token, per params[1]
    ];
    expect(spansForParam(p, results, 'region')).toEqual([text('Region description.')]);
    expect(spansForParam(p, results, 'token')).toEqual([text('Token description.')]);
  });

  it('round-trips through descriptionQueries: each param recovers its OWN description via an identity fake backend', () => {
    const p = preset(
      {
        description: 'Server summary.',
        parameters: {
          // Deliberately inserted in the opposite order from `params` below,
          // same as the zip-order test above, so this test cannot pass by
          // the map and the param list merely happening to agree.
          token: { description: 'Token description.', options: [] },
          region: { description: 'Region description.', options: [] },
        },
      },
      ['region', 'token'],
    );
    const queries = descriptionQueries(p);
    // Stands in for `mcp_description_spans`: wraps each raw string as its own
    // single text span, preserving position -- the "order in equals order
    // out" contract the real command pins with its own test.
    const results = queries.map((q) => [text(q)]);
    expect(spansForServer(p, results)).toEqual([text('Server summary.')]);
    expect(spansForParam(p, results, 'region')).toEqual([text('Region description.')]);
    expect(spansForParam(p, results, 'token')).toEqual([text('Token description.')]);
  });
});
