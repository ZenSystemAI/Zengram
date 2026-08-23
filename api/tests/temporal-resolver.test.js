import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemporalQuery, temporalProximityBoost } from '../src/services/temporal-resolver.js';

// All tests use a FIXED reference date so they are deterministic. The resolver
// uses local-time setHours on a Date, so we never assert hardcoded UTC ISO
// strings (those would only hold on a UTC machine). Instead we assert the
// invariants the code clearly intends — end-of-day upper bounds, non-empty
// windows, expected start-of-day / end-of-day relationships derived the same
// way the resolver derives them — which hold regardless of machine timezone.

const REF = '2026-06-12'; // date-only — the LongMemEval question_date pattern

// Helpers that mirror the resolver's own date math, so expectations track the
// machine timezone exactly as the implementation does.
function startOfDay(refStr) {
  const d = new Date(refStr);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfDay(refStr) {
  const d = new Date(refStr);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// 1. BUG-07: today / this-period / recent must use an END-OF-DAY upper bound
//    (these assertions FAIL on the pre-fix code, which used the raw reference
//    instant — ref.toISOString() — as dateTo).
// ---------------------------------------------------------------------------

describe('resolveTemporalQuery — BUG-07 end-of-day upper bound', () => {
  it('"today" with a date-only reference sets dateTo to end-of-reference-day (non-empty window)', () => {
    const r = resolveTemporalQuery('what happened today', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'today');
    // start-of-day lower bound
    assert.equal(r.dateFrom, startOfDay(REF));
    // end-of-day upper bound — this is the fix; pre-fix it was the raw instant
    assert.equal(r.dateTo, endOfDay(REF));
    // window must be non-empty and the upper bound strictly after the raw ref
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom), 'dateTo must be after dateFrom');
    assert.ok(
      new Date(r.dateTo).getTime() > new Date(REF).getTime(),
      'dateTo must be strictly after the raw reference instant (end-of-day, not raw)',
    );
  });

  it('"this week" sets dateTo to end-of-reference-day', () => {
    const r = resolveTemporalQuery('what did we decide this week', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'this_period');
    assert.equal(r.dateTo, endOfDay(REF));
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
    assert.ok(new Date(r.dateTo).getTime() > new Date(REF).getTime());
  });

  it('"this month" sets dateTo to end-of-reference-day and dateFrom to the 1st', () => {
    const r = resolveTemporalQuery('summarize this month', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'this_period');
    assert.equal(r.dateTo, endOfDay(REF));
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
    assert.ok(new Date(r.dateTo).getTime() > new Date(REF).getTime());

    // dateFrom is the first of the reference month, at start-of-day
    const expectedFrom = new Date(REF);
    expectedFrom.setDate(1);
    expectedFrom.setHours(0, 0, 0, 0);
    assert.equal(r.dateFrom, expectedFrom.toISOString());
  });

  it('"this year" sets dateTo to end-of-reference-day and dateFrom to Jan 1', () => {
    const r = resolveTemporalQuery('everything this year', REF);

    assert.equal(r.temporalPattern, 'this_period');
    assert.equal(r.dateTo, endOfDay(REF));

    const expectedFrom = new Date(REF);
    expectedFrom.setMonth(0, 1);
    expectedFrom.setHours(0, 0, 0, 0);
    assert.equal(r.dateFrom, expectedFrom.toISOString());
  });

  it('"recently" spans ~14 days back to end-of-reference-day', () => {
    const r = resolveTemporalQuery('what changed recently', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'recent');
    assert.equal(r.dateTo, endOfDay(REF));
    assert.ok(new Date(r.dateTo).getTime() > new Date(REF).getTime());

    // dateFrom is 14 days before the reference (raw instant - 14d, no setHours)
    const expectedFrom = new Date(REF);
    expectedFrom.setDate(expectedFrom.getDate() - 14);
    assert.equal(r.dateFrom, expectedFrom.toISOString());

    // window spans roughly 14 days
    const spanDays = (new Date(r.dateTo) - new Date(r.dateFrom)) / (1000 * 60 * 60 * 24);
    assert.ok(spanDays > 13 && spanDays < 15.5, `recent window span was ${spanDays} days`);
  });

  it('"recent" (singular) is detected the same as "recently"', () => {
    const r = resolveTemporalQuery('any recent updates', REF);
    assert.equal(r.temporalPattern, 'recent');
    assert.equal(r.dateTo, endOfDay(REF));
  });
});

// ---------------------------------------------------------------------------
// 2. yesterday — already correct; characterize so a regression is caught.
// ---------------------------------------------------------------------------

describe('resolveTemporalQuery — yesterday (already end-of-day)', () => {
  it('produces a full-day window of the day before the reference', () => {
    const r = resolveTemporalQuery('what did I do yesterday', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'yesterday');

    const from = new Date(REF);
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);

    assert.equal(r.dateFrom, from.toISOString());
    assert.equal(r.dateTo, to.toISOString());
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
  });
});

// ---------------------------------------------------------------------------
// 3. Other branches — characterize current behavior (out of scope to change).
//    Assert isTemporalQuery + a sane non-empty window; no exact-buffer asserts.
// ---------------------------------------------------------------------------

describe('resolveTemporalQuery — relative_ago / last_period / named_month', () => {
  it('"3 days ago" → relative_ago with a non-empty window around that day', () => {
    const r = resolveTemporalQuery('the bug from 3 days ago', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'relative_ago');
    assert.ok(r.dateFrom && r.dateTo);
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom), 'window non-empty');
    // window is in the past relative to the reference
    assert.ok(new Date(r.dateFrom) < new Date(REF));
  });

  it('"3  days  ago" with extra spaces still resolves (bounded whitespace, not ReDoS-prone +)', () => {
    const r = resolveTemporalQuery('the bug from 3  days  ago', REF);
    assert.equal(r.temporalPattern, 'relative_ago');
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
  });

  it('"2 weeks ago" → relative_ago with a non-empty window', () => {
    const r = resolveTemporalQuery('that meeting 2 weeks ago', REF);
    assert.equal(r.temporalPattern, 'relative_ago');
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
  });

  it('"1 month ago" → relative_ago spanning a past calendar month', () => {
    const r = resolveTemporalQuery('what happened 1 month ago', REF);
    assert.equal(r.temporalPattern, 'relative_ago');
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
    assert.ok(new Date(r.dateTo) < new Date(REF));
  });

  it('"last month" → last_period with a non-empty past window', () => {
    const r = resolveTemporalQuery('the invoice from last month', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'last_period');
    assert.ok(r.dateFrom && r.dateTo);
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom), 'window non-empty');
    assert.ok(new Date(r.dateFrom) < new Date(REF));
  });

  it('"last year" → last_period spanning the prior calendar year', () => {
    const r = resolveTemporalQuery('our revenue last year', REF);
    assert.equal(r.temporalPattern, 'last_period');
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
    assert.ok(new Date(r.dateTo) < new Date(REF));
  });

  it('"in March" → named_month with a one-month window', () => {
    const r = resolveTemporalQuery('what did we ship in March', REF);

    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'named_month');
    assert.ok(r.dateFrom && r.dateTo);
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom), 'window non-empty');
    // the most recent March on/before the reference, so the window is in the past
    assert.ok(new Date(r.dateFrom) <= new Date(REF));
  });
});

// ---------------------------------------------------------------------------
// 4. Non-temporal queries and ordering detection.
// ---------------------------------------------------------------------------

describe('resolveTemporalQuery — non-temporal + ordering', () => {
  it('non-temporal query reports isTemporalQuery: false', () => {
    const r = resolveTemporalQuery('database config', REF);
    assert.equal(r.isTemporalQuery, false);
    assert.equal(r.temporalPattern, undefined);
  });

  it('invalid reference date short-circuits to non-temporal', () => {
    const r = resolveTemporalQuery('what happened today', 'not-a-date');
    assert.equal(r.isTemporalQuery, false);
  });

  it('"first decision" → ordering asc', () => {
    const r = resolveTemporalQuery('what was the first decision', REF);
    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'ordering');
    assert.equal(r.orderDirection, 'asc');
  });

  it('"latest status" → ordering desc', () => {
    const r = resolveTemporalQuery('latest status', REF);
    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'ordering');
    assert.equal(r.orderDirection, 'desc');
  });

  it('generic temporal words → generic_temporal, no order direction', () => {
    const r = resolveTemporalQuery('when did this happen', REF);
    assert.equal(r.isTemporalQuery, true);
    assert.equal(r.temporalPattern, 'generic_temporal');
    assert.equal(r.orderDirection, undefined);
  });
});

// ---------------------------------------------------------------------------
// 5. temporalProximityBoost — test only; formula is out of scope to change.
// ---------------------------------------------------------------------------

describe('temporalProximityBoost', () => {
  it('same date → boost ~2.0 (max)', () => {
    const boost = temporalProximityBoost('2026-06-12', '2026-06-12');
    assert.ok(Math.abs(boost - 2.0) < 1e-6, `expected ~2.0, got ${boost}`);
  });

  it('far-apart dates → boost approaching 1.0', () => {
    // ~6.4 years apart; exp(-2350/30) underflows to ~0 and toFixed(4) rounds to 1.
    const boost = temporalProximityBoost('2020-01-01', '2026-06-12');
    assert.ok(boost >= 1.0 && boost < 1.01, `expected ~1.0, got ${boost}`);
  });

  it('boost decays monotonically with distance', () => {
    const near = temporalProximityBoost('2026-06-10', '2026-06-12');
    const mid = temporalProximityBoost('2026-05-12', '2026-06-12');
    const far = temporalProximityBoost('2026-01-12', '2026-06-12');
    assert.ok(near > mid, 'nearer date should boost more than mid');
    assert.ok(mid > far, 'mid date should boost more than far');
  });

  it('boost is symmetric (uses absolute time difference)', () => {
    const a = temporalProximityBoost('2026-06-01', '2026-06-12');
    const b = temporalProximityBoost('2026-06-12', '2026-06-01');
    assert.equal(a, b);
  });

  it('half-life parameter controls decay rate', () => {
    // At exactly one half-life away, boost = 1 + e^-1 ≈ 1.3679
    const boost = temporalProximityBoost('2026-05-13', '2026-06-12', 30);
    assert.ok(Math.abs(boost - (1 + Math.exp(-1))) < 1e-3, `got ${boost}`);
  });

  it('invalid or missing dates → 1.0 (no boost)', () => {
    assert.equal(temporalProximityBoost('not-a-date', '2026-06-12'), 1.0);
    assert.equal(temporalProximityBoost('2026-06-12', 'not-a-date'), 1.0);
    assert.equal(temporalProximityBoost(null, '2026-06-12'), 1.0);
    assert.equal(temporalProximityBoost('2026-06-12', undefined), 1.0);
  });
});
