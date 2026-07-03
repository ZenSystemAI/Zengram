import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmOutputError,
  consolidationJobStatus,
  consolidationRunStatus,
  extractConsolidationJson,
  isSupersedableType,
  parseConsolidationResponse,
  resolveContradiction,
  selectBacklog,
  mergeConnections,
} from '../src/services/consolidation-utils.js';

describe('extractConsolidationJson', () => {
  it('extracts fenced JSON', () => {
    assert.equal(
      extractConsolidationJson('```json\n{"merged_facts":[]}\n```'),
      '{"merged_facts":[]}'
    );
  });

  it('extracts the first balanced object from local-model chatter', () => {
    assert.equal(
      extractConsolidationJson('Here is the result:\n{"merged_facts":[{"content":"a {nested} value"}]}\nDone.'),
      '{"merged_facts":[{"content":"a {nested} value"}]}'
    );
  });
});

describe('parseConsolidationResponse', () => {
  it('parses a valid consolidation object', () => {
    assert.deepEqual(parseConsolidationResponse('{"merged_facts":[],"contradictions":[]}'), {
      merged_facts: [],
      contradictions: [],
    });
  });

  it('allows missing optional arrays', () => {
    assert.deepEqual(parseConsolidationResponse('{}'), {});
  });

  it('rejects invalid JSON as retryable LLM output', () => {
    assert.throws(
      () => parseConsolidationResponse('{not json'),
      (err) => err instanceof LlmOutputError && err.retryable === true
    );
  });

  it('rejects non-object JSON', () => {
    assert.throws(
      () => parseConsolidationResponse('[]'),
      /non-object JSON/
    );
  });

  it('rejects present consolidation fields with non-array values', () => {
    assert.throws(
      () => parseConsolidationResponse('{"merged_facts":{"content":"bad"}}'),
      /merged_facts must be an array/
    );
  });
});

describe('consolidation status helpers', () => {
  it('marks runs with failed batches as partial', () => {
    assert.equal(consolidationRunStatus([]), 'complete');
    assert.equal(consolidationRunStatus([{ error: 'invalid JSON' }]), 'partial');
  });

  it('maps partial run results to partial async jobs', () => {
    assert.equal(consolidationJobStatus({ status: 'complete' }), 'complete');
    assert.equal(consolidationJobStatus({ status: 'partial' }), 'partial');
  });
});

describe('isSupersedableType', () => {
  it('allows superseding facts and statuses', () => {
    assert.equal(isSupersedableType('fact'), true);
    assert.equal(isSupersedableType('status'), true);
  });

  it('preserves events and decisions as historical records', () => {
    assert.equal(isSupersedableType('event'), false);
    assert.equal(isSupersedableType('decision'), false);
  });

  it('rejects unknown or missing types', () => {
    assert.equal(isSupersedableType('insight'), false);
    assert.equal(isSupersedableType(''), false);
    assert.equal(isSupersedableType(null), false);
    assert.equal(isSupersedableType(undefined), false);
  });
});

describe('resolveContradiction', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('honors a suggestion that names memory A by id (supersede B)', () => {
    const r = resolveContradiction({ idA: A, idB: B, timeA: 1, timeB: 2, suggestion: `Keep ${A}, it is verified` });
    assert.deepEqual(r, { keepId: A, supersedeId: B, basis: 'suggestion' });
  });

  it('honors a suggestion that names memory B by id (supersede A)', () => {
    const r = resolveContradiction({ idA: A, idB: B, timeA: 2, timeB: 1, suggestion: `${B} is correct` });
    assert.deepEqual(r, { keepId: B, supersedeId: A, basis: 'suggestion' });
  });

  it('honors "memory_a" / "memory_b" phrasing', () => {
    assert.equal(resolveContradiction({ idA: A, idB: B, suggestion: 'memory_a is likely correct' }).keepId, A);
    assert.equal(resolveContradiction({ idA: A, idB: B, suggestion: 'prefer memory_b here' }).keepId, B);
  });

  it('honors "newer"/"older" phrasing against timestamps', () => {
    // A is newer (time 5 > 3) → "newer is correct" keeps A
    assert.equal(resolveContradiction({ idA: A, idB: B, timeA: 5, timeB: 3, suggestion: 'the newer one is correct' }).keepId, A);
    // A is older (time 1 < 4) → "older is correct" keeps A
    assert.equal(resolveContradiction({ idA: A, idB: B, timeA: 1, timeB: 4, suggestion: 'trust the original older record' }).keepId, A);
  });

  it('falls back to newer-wins by timestamp when the suggestion is unclear', () => {
    // A older (1) than B (2): supersede A, keep B
    const r = resolveContradiction({ idA: A, idB: B, timeA: 1, timeB: 2, suggestion: 'they conflict somehow' });
    assert.deepEqual(r, { keepId: B, supersedeId: A, basis: 'timestamp' });
  });

  it('falls back when the suggestion is empty', () => {
    const r = resolveContradiction({ idA: A, idB: B, timeA: 9, timeB: 2, suggestion: '' });
    assert.deepEqual(r, { keepId: A, supersedeId: B, basis: 'timestamp' });
  });

  it('does not honor a suggestion that mentions both ids (ambiguous → timestamp)', () => {
    const r = resolveContradiction({ idA: A, idB: B, timeA: 1, timeB: 2, suggestion: `${A} and ${B} both say things` });
    assert.equal(r.basis, 'timestamp');
  });
});

describe('selectBacklog', () => {
  // scrollPoints returns newest-first; selectBacklog reverses to oldest-first.
  const newestFirst = [{ id: 'n3' }, { id: 'n2' }, { id: 'n1' }, { id: 'n0' }];

  it('caps to the oldest N and reports the remainder', () => {
    const { selected, remaining } = selectBacklog(newestFirst, 2);
    assert.deepEqual(selected.map(p => p.id), ['n0', 'n1']);
    assert.equal(remaining, 2);
  });

  it('returns everything oldest-first when under the cap', () => {
    const { selected, remaining } = selectBacklog(newestFirst, 10);
    assert.deepEqual(selected.map(p => p.id), ['n0', 'n1', 'n2', 'n3']);
    assert.equal(remaining, 0);
  });

  it('treats a non-positive or non-finite cap as no cap', () => {
    assert.equal(selectBacklog(newestFirst, 0).selected.length, 4);
    assert.equal(selectBacklog(newestFirst, NaN).selected.length, 4);
  });

  it('handles empty / non-array input', () => {
    assert.deepEqual(selectBacklog([], 5), { selected: [], remaining: 0 });
    assert.deepEqual(selectBacklog(undefined, 5), { selected: [], remaining: 0 });
  });
});

describe('mergeConnections', () => {
  it('merges existing and incoming, existing-first, deduped', () => {
    assert.deepEqual(mergeConnections(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  });

  it('drops falsy ids', () => {
    assert.deepEqual(mergeConnections(['a'], [null, undefined, '', 'd']), ['a', 'd']);
  });

  it('caps the total number of connections', () => {
    const existing = Array.from({ length: 18 }, (_, i) => `e${i}`);
    const incoming = ['x', 'y', 'z'];
    const out = mergeConnections(existing, incoming, 20);
    assert.equal(out.length, 20);
    assert.equal(out[18], 'x');
    assert.equal(out[19], 'y');
  });

  it('defaults to empty arrays', () => {
    assert.deepEqual(mergeConnections(), []);
  });
});
