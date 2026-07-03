import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemporalQuery } from '../src/services/temporal-resolver.js';

// These tests pin BRAIN_TIMEZONE explicitly and use fixed reference INSTANTS, so
// their assertions are exact ISO strings that hold regardless of the machine's
// own timezone. This is the coverage that would have caught the civil-day bug:
// a Toronto (UTC-4) evening used to resolve "today" into the next UTC day.

const savedTz = process.env.BRAIN_TIMEZONE;
afterEach(() => {
  if (savedTz === undefined) delete process.env.BRAIN_TIMEZONE;
  else process.env.BRAIN_TIMEZONE = savedTz;
});

describe('resolveTemporalQuery — timezone-aware civil day (America/Toronto)', () => {
  it('"today" at a Toronto evening resolves to the Toronto civil day, not the UTC day', () => {
    process.env.BRAIN_TIMEZONE = 'America/Toronto';
    // 2026-06-12T23:30:00Z === 2026-06-12 19:30 in Toronto (EDT, UTC-4).
    // The correct civil day is June 12; the pre-fix UTC math would have drifted.
    const r = resolveTemporalQuery('what happened today', '2026-06-12T23:30:00Z');

    assert.equal(r.temporalPattern, 'today');
    // June 12 00:00:00.000 Toronto === 04:00Z; June 12 23:59:59.999 Toronto === next-day 03:59:59.999Z.
    assert.equal(r.dateFrom, '2026-06-12T04:00:00.000Z');
    assert.equal(r.dateTo, '2026-06-13T03:59:59.999Z');
  });

  it('"yesterday" at a Toronto evening is the full prior Toronto civil day', () => {
    process.env.BRAIN_TIMEZONE = 'America/Toronto';
    const r = resolveTemporalQuery('what did I do yesterday', '2026-06-12T23:30:00Z');

    assert.equal(r.temporalPattern, 'yesterday');
    assert.equal(r.dateFrom, '2026-06-11T04:00:00.000Z');
    assert.equal(r.dateTo, '2026-06-12T03:59:59.999Z');
  });

  it('the same instant resolves to a different civil day under UTC', () => {
    process.env.BRAIN_TIMEZONE = 'UTC';
    const r = resolveTemporalQuery('what happened today', '2026-06-12T23:30:00Z');

    assert.equal(r.temporalPattern, 'today');
    assert.equal(r.dateFrom, '2026-06-12T00:00:00.000Z');
    assert.equal(r.dateTo, '2026-06-12T23:59:59.999Z');
  });

  it('"this month" boundaries are computed in the configured zone', () => {
    process.env.BRAIN_TIMEZONE = 'America/Toronto';
    const r = resolveTemporalQuery('summarize this month', '2026-06-12T23:30:00Z');

    assert.equal(r.temporalPattern, 'this_period');
    // June 1 00:00 Toronto (EDT) === 04:00Z
    assert.equal(r.dateFrom, '2026-06-01T04:00:00.000Z');
    assert.equal(r.dateTo, '2026-06-13T03:59:59.999Z');
  });

  it('an invalid BRAIN_TIMEZONE falls back instead of throwing', () => {
    process.env.BRAIN_TIMEZONE = 'Not/AZone';
    // Should not throw; still classifies as a temporal query with a valid window.
    const r = resolveTemporalQuery('what happened today', '2026-06-12T12:00:00Z');
    assert.equal(r.temporalPattern, 'today');
    assert.ok(new Date(r.dateTo) > new Date(r.dateFrom));
  });
});

describe('resolveTemporalQuery — month-arithmetic overflow (BUG: Jan 31 - N months)', () => {
  // Pre-fix, "N months ago" ran setMonth() on a day-31 date, spilling into the
  // wrong month and producing an INVERTED (dateFrom > dateTo) / empty window.
  it('"2 months ago" from Jan 31 yields a non-inverted November window', () => {
    process.env.BRAIN_TIMEZONE = 'UTC';
    const r = resolveTemporalQuery('what happened 2 months ago', '2026-01-31T12:00:00Z');

    assert.equal(r.temporalPattern, 'relative_ago');
    // Jan 2026 minus 2 months === November 2025 — not September/December drift.
    assert.equal(r.dateFrom, '2025-11-01T00:00:00.000Z');
    assert.equal(r.dateTo, '2025-11-30T23:59:59.999Z');
    assert.ok(new Date(r.dateFrom) < new Date(r.dateTo), 'window must not be inverted');
  });

  it('"1 month ago" from Jan 31 yields December (day-of-month cannot overflow)', () => {
    process.env.BRAIN_TIMEZONE = 'UTC';
    const r = resolveTemporalQuery('the bug from 1 month ago', '2026-01-31T12:00:00Z');

    assert.equal(r.temporalPattern, 'relative_ago');
    assert.equal(r.dateFrom, '2025-12-01T00:00:00.000Z');
    assert.equal(r.dateTo, '2025-12-31T23:59:59.999Z');
  });

  it('"N months ago" never inverts for a day-31 reference across N=1..6', () => {
    process.env.BRAIN_TIMEZONE = 'UTC';
    for (let n = 1; n <= 6; n++) {
      const r = resolveTemporalQuery(`what happened ${n} months ago`, '2026-01-31T12:00:00Z');
      assert.equal(r.temporalPattern, 'relative_ago', `N=${n}`);
      assert.ok(
        new Date(r.dateFrom) < new Date(r.dateTo),
        `N=${n}: window inverted (${r.dateFrom} .. ${r.dateTo})`,
      );
    }
  });
});
