import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, rrfWeights } from '../src/services/rrf.js';

describe('reciprocalRankFusion — weighted', () => {
  it('defaults (no weights) are unchanged from vanilla RRF', () => {
    const lists = [
      [{ id: 'a', source: 'vector' }, { id: 'b', source: 'vector' }],
      [{ id: 'b', source: 'keyword' }, { id: 'c', source: 'keyword' }],
    ];
    const plain = reciprocalRankFusion(lists);
    const explicit1 = reciprocalRankFusion(lists, 60, [1, 1]);
    assert.deepEqual(plain.map(r => r.id), explicit1.map(r => r.id));
    assert.equal(plain[0].rrf_score, explicit1[0].rrf_score);
  });

  it('upweighting the vector list lifts a vector-only top hit above a keyword-only hit', () => {
    // a is rank-1 vector-only; c is rank-1 keyword-only. With a big vector
    // weight, a should outrank c.
    const lists = [
      [{ id: 'a', source: 'vector' }],
      [{ id: 'c', source: 'keyword' }],
    ];
    const weighted = reciprocalRankFusion(lists, 60, [5, 1]);
    assert.equal(weighted[0].id, 'a');
    assert.ok(weighted[0].rrf_score > weighted[1].rrf_score);
  });

  it('weights align to ORIGINAL list indices even when an earlier list is empty', () => {
    const lists = [
      [], // vector path returned nothing
      [{ id: 'c', source: 'keyword' }],
    ];
    // keyword weight is index 1 → 3; score should be 3/(60+1)
    const out = reciprocalRankFusion(lists, 60, [1, 3]);
    assert.equal(out[0].id, 'c');
    assert.ok(Math.abs(out[0].rrf_score - 3 / 61) < 1e-9);
  });
});

describe('rrfWeights — env parsing', () => {
  const v = process.env.RRF_VECTOR_WEIGHT, k = process.env.RRF_KEYWORD_WEIGHT;
  afterEach(() => {
    if (v === undefined) delete process.env.RRF_VECTOR_WEIGHT; else process.env.RRF_VECTOR_WEIGHT = v;
    if (k === undefined) delete process.env.RRF_KEYWORD_WEIGHT; else process.env.RRF_KEYWORD_WEIGHT = k;
  });

  it('defaults to [1, 1]', () => {
    delete process.env.RRF_VECTOR_WEIGHT; delete process.env.RRF_KEYWORD_WEIGHT;
    assert.deepEqual(rrfWeights(), [1, 1]);
  });

  it('reads valid overrides and ignores invalid/negative', () => {
    process.env.RRF_VECTOR_WEIGHT = '2.5'; process.env.RRF_KEYWORD_WEIGHT = '-3';
    assert.deepEqual(rrfWeights(), [2.5, 1]);
  });
});
