import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { queryEntityNames, rrfGraphWeight, GRAPH_RETRIEVAL_ENABLED, graphCandidates } from '../src/services/graph-retrieval.js';
import { loadAliasCache } from '../src/services/entities.js';

describe('queryEntityNames', () => {
  it('returns [] for empty/non-string queries', () => {
    assert.deepEqual(queryEntityNames(''), []);
    assert.deepEqual(queryEntityNames(null), []);
    assert.deepEqual(queryEntityNames(42), []);
  });

  it('extracts known-technology names from the query, lowercased', () => {
    // 'postgres' is in the KNOWN_TECH dictionary shipping with the extractor
    const names = queryEntityNames('why is postgres slow on writes?');
    assert.ok(names.includes('postgresql') || names.includes('postgres'),
      `expected a postgres entity, got: ${JSON.stringify(names)}`);
    for (const n of names) assert.equal(n, n.toLowerCase());
  });

  it('resolves aliases through the shared alias cache and dedupes', () => {
    loadAliasCache([
      { alias: 'the widget system', entity_id: 7, canonical_name: 'Widget System', entity_type: 'system' },
    ]);
    const names = queryEntityNames('status of "the widget system" and "the widget system" again');
    assert.equal(names.filter(n => n === 'widget system').length, 1);
  });

  it('does not extract prose words as entities', () => {
    const names = queryEntityNames('what happened during the meeting yesterday afternoon');
    assert.deepEqual(names, []);
  });
});

describe('rrfGraphWeight', () => {
  const orig = process.env.RRF_GRAPH_WEIGHT;
  afterEach(() => {
    if (orig === undefined) delete process.env.RRF_GRAPH_WEIGHT; else process.env.RRF_GRAPH_WEIGHT = orig;
  });

  it('defaults to 0.5', () => {
    delete process.env.RRF_GRAPH_WEIGHT;
    assert.equal(rrfGraphWeight(), 0.5);
  });

  it('reads a valid override and ignores invalid/negative values', () => {
    process.env.RRF_GRAPH_WEIGHT = '0.8';
    assert.equal(rrfGraphWeight(), 0.8);
    process.env.RRF_GRAPH_WEIGHT = '-1';
    assert.equal(rrfGraphWeight(), 0.5);
    process.env.RRF_GRAPH_WEIGHT = 'nope';
    assert.equal(rrfGraphWeight(), 0.5);
  });
});

describe('graphCandidates — gating', () => {
  it('is disabled by default (no env flag set in tests)', () => {
    assert.equal(GRAPH_RETRIEVAL_ENABLED, false);
  });

  it('returns [] without touching the store when disabled', async () => {
    // No store is initialized in unit tests — this would throw if the gate leaked.
    const out = await graphCandidates('postgres deployment', { clientId: 'acme-corp' });
    assert.deepEqual(out, []);
  });
});
