import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion } from '../src/services/rrf.js';

// ---------------------------------------------------------------------------
// 1. Basic fusion
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion — basic', () => {
  it('fuses two lists with overlapping items', () => {
    const list1 = [
      { id: 'a', source: 'vector' },
      { id: 'b', source: 'vector' },
      { id: 'c', source: 'vector' },
    ];
    const list2 = [
      { id: 'b', source: 'keyword' },
      { id: 'a', source: 'keyword' },
      { id: 'd', source: 'keyword' },
    ];

    const result = reciprocalRankFusion([list1, list2], 60);

    // 'a' and 'b' appear in both lists — should be top 2
    assert.equal(result[0].id, 'a'); // rank 1 in list1 + rank 2 in list2
    assert.equal(result[1].id, 'b'); // rank 2 in list1 + rank 1 in list2
    // Both should have same score (symmetric: rank 1+2 = rank 2+1)
    assert.equal(result[0].rrf_score.toFixed(6), result[1].rrf_score.toFixed(6));
    // 'c' and 'd' only in one list each
    assert.ok(result.find(r => r.id === 'c'));
    assert.ok(result.find(r => r.id === 'd'));
  });

  it('item in more lists beats item in fewer lists', () => {
    const list1 = [{ id: 'a', source: 'v' }, { id: 'b', source: 'v' }];
    const list2 = [{ id: 'a', source: 'k' }, { id: 'c', source: 'k' }];
    const list3 = [{ id: 'a', source: 'g' }, { id: 'd', source: 'g' }];

    const result = reciprocalRankFusion([list1, list2, list3], 60);

    // 'a' appears in all 3 lists at rank 1 — highest score
    assert.equal(result[0].id, 'a');
    assert.equal(result[0].sources.length, 3);
    // All single-list items have lower scores
    for (const r of result.slice(1)) {
      assert.ok(r.rrf_score < result[0].rrf_score);
    }
  });

  it('respects rank ordering within a list', () => {
    const list1 = [
      { id: 'first', source: 'v' },
      { id: 'second', source: 'v' },
      { id: 'third', source: 'v' },
    ];

    const result = reciprocalRankFusion([list1], 60);

    assert.equal(result[0].id, 'first');
    assert.equal(result[1].id, 'second');
    assert.equal(result[2].id, 'third');
    assert.ok(result[0].rrf_score > result[1].rrf_score);
    assert.ok(result[1].rrf_score > result[2].rrf_score);
  });
});

// ---------------------------------------------------------------------------
// 2. Edge cases
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion — edge cases', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
    assert.deepEqual(reciprocalRankFusion(null), []);
    assert.deepEqual(reciprocalRankFusion(undefined), []);
  });

  it('handles empty lists within input', () => {
    const list1 = [{ id: 'a', source: 'v' }];
    const result = reciprocalRankFusion([list1, [], null, []], 60);

    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a');
  });

  it('single list passthrough preserves order', () => {
    const list = [
      { id: 'x', source: 'vector' },
      { id: 'y', source: 'vector' },
      { id: 'z', source: 'vector' },
    ];

    const result = reciprocalRankFusion([list], 60);

    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'x');
    assert.equal(result[1].id, 'y');
    assert.equal(result[2].id, 'z');
  });

  it('handles items without source field', () => {
    const list1 = [{ id: 'a' }, { id: 'b' }];
    const list2 = [{ id: 'b' }, { id: 'c' }];

    const result = reciprocalRankFusion([list1, list2], 60);

    assert.ok(result.length >= 2);
    assert.ok(result[0].sources.length > 0); // should have default source
  });

  it('skips items without id', () => {
    const list1 = [{ id: 'a', source: 'v' }, { source: 'v' }, null, { id: 'b', source: 'v' }];

    const result = reciprocalRankFusion([list1], 60);

    assert.equal(result.length, 2);
  });

  it('no duplicate sources for same item in same list', () => {
    // If somehow the same id appears twice in one list
    const list1 = [
      { id: 'a', source: 'vector' },
      { id: 'a', source: 'vector' },
    ];

    const result = reciprocalRankFusion([list1], 60);
    const itemA = result.find(r => r.id === 'a');
    assert.equal(itemA.sources.length, 1); // no duplicate source
  });
});

// ---------------------------------------------------------------------------
// 3. Score properties
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion — score properties', () => {
  it('k parameter affects score magnitude', () => {
    const list = [{ id: 'a', source: 'v' }];

    const resultLowK = reciprocalRankFusion([list], 10);
    const resultHighK = reciprocalRankFusion([list], 100);

    // Lower k = higher scores (1/(10+1) > 1/(100+1))
    assert.ok(resultLowK[0].rrf_score > resultHighK[0].rrf_score);
  });

  it('score formula is correct: 1/(k+rank)', () => {
    const k = 60;
    const list = [{ id: 'a', source: 'v' }];

    const result = reciprocalRankFusion([list], k);

    // rank=1 (0-indexed rank 0 → formula uses rank+1=1)
    const expected = 1 / (k + 1);
    assert.equal(result[0].rrf_score, expected);
  });

  it('cross-list accumulation is correct', () => {
    const k = 60;
    const list1 = [{ id: 'a', source: 'v' }]; // rank 1
    const list2 = [{ id: 'b', source: 'k' }, { id: 'a', source: 'k' }]; // a at rank 2

    const result = reciprocalRankFusion([list1, list2], k);

    const itemA = result.find(r => r.id === 'a');
    const expected = (1 / (k + 1)) + (1 / (k + 2)); // rank 1 in list1 + rank 2 in list2
    assert.ok(Math.abs(itemA.rrf_score - expected) < 1e-10);
  });
});

// ---------------------------------------------------------------------------
// 4. Realistic scenario — 3 retrieval paths
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion — 3-path scenario', () => {
  it('vector + keyword + graph fusion', () => {
    const vector = [
      { id: 'mem-1', source: 'vector' },
      { id: 'mem-2', source: 'vector' },
      { id: 'mem-3', source: 'vector' },
      { id: 'mem-4', source: 'vector' },
    ];
    const keyword = [
      { id: 'mem-2', source: 'keyword' }, // exact name match
      { id: 'mem-5', source: 'keyword' }, // keyword-only hit
      { id: 'mem-1', source: 'keyword' },
    ];
    const graph = [
      { id: 'mem-3', source: 'graph' },  // entity-linked
      { id: 'mem-6', source: 'graph' },  // graph-only hit
      { id: 'mem-2', source: 'graph' },
    ];

    const result = reciprocalRankFusion([vector, keyword, graph], 60);

    // mem-2 appears in all 3 lists — should be #1
    assert.equal(result[0].id, 'mem-2');
    assert.deepEqual(result[0].sources.sort(), ['graph', 'keyword', 'vector']);

    // mem-1 and mem-3 each appear in 2 lists
    const top3Ids = result.slice(0, 3).map(r => r.id);
    assert.ok(top3Ids.includes('mem-2'));

    // mem-5, mem-6 are single-list — should be lower
    const mem5 = result.find(r => r.id === 'mem-5');
    const mem6 = result.find(r => r.id === 'mem-6');
    assert.ok(mem5.rrf_score < result[0].rrf_score);
    assert.ok(mem6.rrf_score < result[0].rrf_score);

    // Total unique IDs = 6
    assert.equal(result.length, 6);
  });
});
