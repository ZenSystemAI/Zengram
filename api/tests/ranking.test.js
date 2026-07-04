import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveScore, accessBoost, extractSessionId, diversifyBySession,
  RANK_W_SIM, RANK_W_RRF, RANK_ACCESS_BOOST_CAP, RANK_KEYWORD_ONLY_SIM,
  IMPORTANCE_WEIGHTS,
} from '../src/services/ranking.js';

// ---------------------------------------------------------------------------
// 1. effectiveScore — blend behavior
// ---------------------------------------------------------------------------

describe('effectiveScore — fusion blend', () => {
  it('blends similarity with normalized RRF in multi-path mode', () => {
    const score = effectiveScore({
      simScore: 0.8,
      rrfScore: 0.02,
      maxRrfScore: 0.04,
      effectiveConfidence: 1.0,
      accessCount: 0,
      importance: 'critical', // weight 1.0 to isolate the blend
    });
    const expected = +(RANK_W_SIM * 0.8 + RANK_W_RRF * 0.5).toFixed(4);
    assert.equal(score, expected);
  });

  it('a doc found by BOTH paths outranks an equal-similarity doc found by one path', () => {
    const both = effectiveScore({
      simScore: 0.7, rrfScore: 0.032, maxRrfScore: 0.032,
      effectiveConfidence: 1, accessCount: 0, importance: 'medium',
    });
    const vectorOnly = effectiveScore({
      simScore: 0.7, rrfScore: 0.016, maxRrfScore: 0.032,
      effectiveConfidence: 1, accessCount: 0, importance: 'medium',
    });
    assert.ok(both > vectorOnly, `expected ${both} > ${vectorOnly}`);
  });

  it('collapses to raw similarity in single-path mode (no rrf inputs)', () => {
    const score = effectiveScore({
      simScore: 0.8, rrfScore: null, maxRrfScore: null,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.equal(score, 0.8);
  });

  it('keyword-only results use the floor stand-in, not a fabricated mid similarity', () => {
    const kwOnly = effectiveScore({
      simScore: null, rrfScore: 0.016, maxRrfScore: 0.032,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    const expected = +(RANK_W_SIM * RANK_KEYWORD_ONLY_SIM + RANK_W_RRF * 0.5).toFixed(4);
    assert.equal(kwOnly, expected);
    // A genuine vector match above the stand-in must beat an equal-RRF keyword-only hit
    const vectorMatch = effectiveScore({
      simScore: RANK_KEYWORD_ONLY_SIM + 0.1, rrfScore: 0.016, maxRrfScore: 0.032,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.ok(vectorMatch > kwOnly);
  });

  it('a score of 0 is honored, not treated as missing (the old || 0.5 bug)', () => {
    const zeroSim = effectiveScore({
      simScore: 0, rrfScore: null, maxRrfScore: null,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.equal(zeroSim, 0);
  });
});

// ---------------------------------------------------------------------------
// 1b. effectiveScore — cross-encoder rerank
// ---------------------------------------------------------------------------

describe('effectiveScore — rerank score', () => {
  it('a rerank score replaces the sim/RRF blend as the base', () => {
    const score = effectiveScore({
      simScore: 0.2, rrfScore: 0.005, maxRrfScore: 0.04, rerankScore: 0.9,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.equal(score, 0.9);
  });

  it('multipliers still apply on top of the rerank score', () => {
    const score = effectiveScore({
      simScore: 0.2, rrfScore: null, maxRrfScore: null, rerankScore: 0.8,
      effectiveConfidence: 0.5, accessCount: 0, importance: 'critical',
    });
    assert.equal(score, 0.4);
  });

  it('a rerank score of 0 is honored, not treated as missing', () => {
    const score = effectiveScore({
      simScore: 0.9, rrfScore: 0.04, maxRrfScore: 0.04, rerankScore: 0,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.equal(score, 0);
  });

  it('null/undefined rerank score falls back to the blend', () => {
    const withNull = effectiveScore({
      simScore: 0.8, rrfScore: 0.02, maxRrfScore: 0.04, rerankScore: null,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    const without = effectiveScore({
      simScore: 0.8, rrfScore: 0.02, maxRrfScore: 0.04,
      effectiveConfidence: 1, accessCount: 0, importance: 'critical',
    });
    assert.equal(withNull, without);
  });
});

// ---------------------------------------------------------------------------
// 2. Multipliers
// ---------------------------------------------------------------------------

describe('effectiveScore — multipliers', () => {
  it('applies importance weights', () => {
    const base = { simScore: 1, rrfScore: null, maxRrfScore: null, effectiveConfidence: 1, accessCount: 0 };
    for (const [imp, weight] of Object.entries(IMPORTANCE_WEIGHTS)) {
      assert.equal(effectiveScore({ ...base, importance: imp }), +weight.toFixed(4));
    }
    // Unknown importance falls back to medium
    assert.equal(effectiveScore({ ...base, importance: 'nonsense' }), IMPORTANCE_WEIGHTS.medium);
  });

  it('caps the access boost', () => {
    assert.equal(accessBoost(0), 1);
    assert.ok(accessBoost(7) > 1 && accessBoost(7) <= RANK_ACCESS_BOOST_CAP);
    // A memory read thousands of times must not dominate ranking
    assert.equal(accessBoost(100000), RANK_ACCESS_BOOST_CAP);
  });

  it('applies temporal boost multiplicatively', () => {
    const base = { simScore: 0.5, rrfScore: null, maxRrfScore: null, effectiveConfidence: 1, accessCount: 0, importance: 'critical' };
    assert.equal(effectiveScore({ ...base, temporalBoost: 2 }), 1.0);
  });
});

// ---------------------------------------------------------------------------
// 3. Session extraction
// ---------------------------------------------------------------------------

describe('extractSessionId', () => {
  it('prefers metadata.session_id', () => {
    assert.equal(extractSessionId({ metadata: { session_id: 's1' }, text: '[Session: s2 | foo]' }), 's1');
  });
  it('falls back to the content header', () => {
    assert.equal(extractSessionId({ text: '[Session: abc-123 | 2026-07-01]\nDid things.' }), 'abc-123');
  });
  it('returns null when untagged', () => {
    assert.equal(extractSessionId({ text: 'plain memory' }), null);
    assert.equal(extractSessionId({}), null);
  });
});

// ---------------------------------------------------------------------------
// 4. Session diversification
// ---------------------------------------------------------------------------

describe('diversifyBySession', () => {
  const mk = (id, score, session) => ({ id, effective_score: score, session });
  const getSession = (item) => item.session || null;

  it('passes through small result sets untouched', () => {
    const items = [mk('a', 0.9, 's1'), mk('b', 0.8, 's1'), mk('c', 0.7, 's1')];
    assert.deepEqual(diversifyBySession(items, getSession), items);
  });

  it('round-robins across sessions: each session\'s best comes before any session\'s second', () => {
    const items = [
      mk('a1', 0.9, 's1'), mk('a2', 0.85, 's1'), mk('a3', 0.8, 's1'),
      mk('b1', 0.7, 's2'), mk('c1', 0.6, 's3'),
    ];
    const out = diversifyBySession(items, getSession);
    assert.deepEqual(out.map(i => i.id), ['a1', 'b1', 'c1', 'a2', 'a3']);
  });

  it('untagged results compete at rank 0 instead of sinking below every tagged result', () => {
    const items = [
      mk('s1a', 0.9, 's1'), mk('s1b', 0.85, 's1'), mk('s1c', 0.8, 's1'),
      mk('solo', 0.88, null), // high-relevance untagged — the old code buried this last
    ];
    const out = diversifyBySession(items, getSession);
    assert.deepEqual(out.map(i => i.id), ['s1a', 'solo', 's1b', 's1c']);
  });

  it('does not mutate items and preserves score order within a rank tier', () => {
    const items = [mk('a', 0.9, 's1'), mk('b', 0.8, 's2'), mk('c', 0.7, 's3'), mk('d', 0.6, 's4')];
    const out = diversifyBySession(items, getSession);
    assert.deepEqual(out.map(i => i.id), ['a', 'b', 'c', 'd']);
    assert.equal(Object.keys(items[0]).length, 3); // no tagging fields leaked onto items
  });
});
