// Temporal resolver: detects time references in a query and converts them to
// date ranges + optional proximity ordering, so the search handler can filter
// and rerank by recency.
//
// Timezone: civil-day/week/month/year boundaries are computed in BRAIN_TIMEZONE
// (IANA name; defaults to the server's resolved zone). Deployments outside UTC
// used to resolve "today"/"this week" to the wrong civil day — e.g. a Toronto
// evening (UTC-4) fell into the next UTC day. All returned dateFrom/dateTo are
// still ISO UTC instants; only the boundary math is zone-aware.

// Civil-time parts of an instant as seen in a given IANA zone. Month is 1-based.
// Seconds are zone-independent (all offsets are whole minutes) but come from the
// formatter anyway; minutes must come from the zone (e.g. +05:30 zones).
function partsInZone(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return {
    year: +map.year, month: +map.month, day: +map.day,
    hour: +map.hour, minute: +map.minute, second: +map.second,
  };
}

// Offset (ms) of `tz` at `date`: (wall clock as-if-UTC) - (actual instant).
// West-of-UTC zones return a negative value. Computed at second resolution
// (offsets are whole minutes) so ms on `date` must not skew the result.
function tzOffsetMs(tz, date) {
  const p = partsInZone(date, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - (date.getTime() - date.getUTCMilliseconds());
}

// Convert a wall-clock civil time in `tz` to a UTC Date. month0 is 0-based.
// Re-checks the offset once against the first-pass instant so DST edges resolve.
function wallToInstant(tz, year, month0, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const asUTC = Date.UTC(year, month0, day, hour, minute, second, ms);
  const off = tzOffsetMs(tz, new Date(asUTC));
  let inst = asUTC - off;
  const off2 = tzOffsetMs(tz, new Date(inst));
  if (off2 !== off) inst = asUTC - off2;
  return new Date(inst);
}

// Civil-date arithmetic on a bare (year, month0, day) via UTC anchors — safe
// from DST because no wall-clock time is involved until wallToInstant.
function addDays(year, month0, day, delta) {
  const d = new Date(Date.UTC(year, month0, day) + delta * 86400000);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

function addMonths(year, month0, delta) {
  const total = year * 12 + month0 + delta;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

function daysInMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Detect temporal patterns in a query and resolve to date ranges.
 * @param {string} query - The search query
 * @param {string} [referenceDate] - ISO date to resolve relative references against (e.g. question_date)
 * @returns {{ dateFrom?: string, dateTo?: string, isTemporalQuery: boolean, temporalPattern?: string, orderDirection?: 'asc'|'desc' }}
 */
export function resolveTemporalQuery(query, referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  if (isNaN(ref.getTime())) return { isTemporalQuery: false };

  // Resolve boundaries in this zone. Invalid names would make Intl throw, so
  // fall back to the server zone (then UTC) rather than crash the search path.
  let tz = process.env.BRAIN_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    partsInZone(ref, tz);
  } catch {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  // Civil view of the reference instant in the target zone. All branches below
  // derive their windows from this civil date rather than from raw UTC math.
  const rp = partsInZone(ref, tz);
  const refMs = ref.getUTCMilliseconds();
  const endOfRefDay = wallToInstant(tz, rp.year, rp.month - 1, rp.day, 23, 59, 59, 999);

  const q = query.toLowerCase();
  let dateFrom, dateTo, temporalPattern, orderDirection;

  // "yesterday"
  if (!temporalPattern && /\byesterday\b/i.test(q)) {
    const y = addDays(rp.year, rp.month - 1, rp.day, -1);
    dateFrom = wallToInstant(tz, y.year, y.month0, y.day, 0, 0, 0, 0).toISOString();
    dateTo = wallToInstant(tz, y.year, y.month0, y.day, 23, 59, 59, 999).toISOString();
    temporalPattern = 'yesterday';
  }

  // "today"
  if (!temporalPattern && /\btoday\b/i.test(q)) {
    dateFrom = wallToInstant(tz, rp.year, rp.month - 1, rp.day, 0, 0, 0, 0).toISOString();
    dateTo = endOfRefDay.toISOString();
    temporalPattern = 'today';
  }

  // "X days/weeks/months/years ago"
  const agoMatch = !temporalPattern && q.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);
  if (agoMatch) {
    const amount = parseInt(agoMatch[1]);
    const unit = agoMatch[2];

    if (unit === 'day') {
      const from = addDays(rp.year, rp.month - 1, rp.day, -amount - 2); // ±2 day buffer
      const to = addDays(rp.year, rp.month - 1, rp.day, -amount + 2);
      dateFrom = wallToInstant(tz, from.year, from.month0, from.day, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, to.year, to.month0, to.day, 23, 59, 59, 999).toISOString();
    } else if (unit === 'week') {
      const from = addDays(rp.year, rp.month - 1, rp.day, -(amount * 7) - 5);
      const to = addDays(rp.year, rp.month - 1, rp.day, -(amount * 7) + 5);
      dateFrom = wallToInstant(tz, from.year, from.month0, from.day, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, to.year, to.month0, to.day, 23, 59, 59, 999).toISOString();
    } else if (unit === 'month') {
      // addMonths avoids the setMonth day-of-month overflow (Jan 31 - N months
      // used to spill into the wrong month and invert the range).
      const m = addMonths(rp.year, rp.month - 1, -amount);
      dateFrom = wallToInstant(tz, m.year, m.month0, 1, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, m.year, m.month0, daysInMonth(m.year, m.month0), 23, 59, 59, 999).toISOString();
    } else if (unit === 'year') {
      dateFrom = wallToInstant(tz, rp.year - amount, 0, 1, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, rp.year - amount, 11, 31, 23, 59, 59, 999).toISOString();
    }

    temporalPattern = 'relative_ago';
  }

  // "this week/month/year" — window ends at the end of the reference civil day.
  const thisMatch = !temporalPattern && q.match(/\bthis\s+(week|month|year)\b/i);
  if (thisMatch) {
    const unit = thisMatch[1];
    let from;

    if (unit === 'week') {
      const dow = new Date(Date.UTC(rp.year, rp.month - 1, rp.day)).getUTCDay();
      const back = dow === 0 ? 6 : dow - 1; // Monday as week start
      const m = addDays(rp.year, rp.month - 1, rp.day, -back);
      from = wallToInstant(tz, m.year, m.month0, m.day, 0, 0, 0, 0);
    } else if (unit === 'month') {
      from = wallToInstant(tz, rp.year, rp.month - 1, 1, 0, 0, 0, 0);
    } else if (unit === 'year') {
      from = wallToInstant(tz, rp.year, 0, 1, 0, 0, 0, 0);
    }

    dateFrom = from.toISOString();
    dateTo = endOfRefDay.toISOString();
    temporalPattern = 'this_period';
  }

  // "last week/month/year"
  const lastMatch = !temporalPattern && q.match(/\blast\s+(week|month|year)\b/i);
  if (lastMatch) {
    const unit = lastMatch[1];

    if (unit === 'week') {
      // Last ~14 days up to the end of the reference civil day.
      const from = addDays(rp.year, rp.month - 1, rp.day, -14);
      dateFrom = wallToInstant(tz, from.year, from.month0, from.day, 0, 0, 0, 0).toISOString();
      dateTo = endOfRefDay.toISOString();
    } else if (unit === 'month') {
      // Previous calendar month + 5-day buffer on each side.
      const prev = addMonths(rp.year, rp.month - 1, -1);
      const lastDay = daysInMonth(prev.year, prev.month0);
      const from = addDays(prev.year, prev.month0, 1, -5);
      const to = addDays(prev.year, prev.month0, lastDay, 5);
      dateFrom = wallToInstant(tz, from.year, from.month0, from.day, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, to.year, to.month0, to.day, 23, 59, 59, 999).toISOString();
    } else if (unit === 'year') {
      dateFrom = wallToInstant(tz, rp.year - 1, 0, 1, 0, 0, 0, 0).toISOString();
      dateTo = wallToInstant(tz, rp.year - 1, 11, 31, 23, 59, 59, 999).toISOString();
    }

    temporalPattern = 'last_period';
  }

  // "recently" / "recent" — last 2 weeks, preserving the reference time-of-day
  // on the lower bound (matches the historical window shape).
  if (!temporalPattern && /\b(recently|recent)\b/i.test(q)) {
    const from = addDays(rp.year, rp.month - 1, rp.day, -14);
    dateFrom = wallToInstant(tz, from.year, from.month0, from.day, rp.hour, rp.minute, rp.second, refMs).toISOString();
    dateTo = endOfRefDay.toISOString();
    temporalPattern = 'recent';
  }

  // "in January/February/.../December" or "in Jan/Feb/..."
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const monthMatch = !temporalPattern && q.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
  if (monthMatch) {
    const name = monthMatch[1].toLowerCase();
    let monthIdx = monthNames.indexOf(name);
    if (monthIdx === -1) monthIdx = monthAbbr.indexOf(name);
    if (monthIdx >= 0) {
      // Assume the most recent occurrence of that month on/before the reference.
      let year = rp.year;
      let from = wallToInstant(tz, year, monthIdx, 1, 0, 0, 0, 0);
      if (from > ref) {
        year -= 1;
        from = wallToInstant(tz, year, monthIdx, 1, 0, 0, 0, 0);
      }
      const next = addMonths(year, monthIdx, 1);
      const to = wallToInstant(tz, next.year, next.month0, 1, 0, 0, 0, 0);

      dateFrom = from.toISOString();
      dateTo = to.toISOString();
      temporalPattern = 'named_month';
    }
  }

  // Ordering/sequence detection — signals that results should be date-sorted.
  // orderDirection is surfaced in the result; the memory route wires it into the
  // query ORDER BY in a follow-up (kept detection-only here on purpose).
  const firstEarliestMatch = /\b(first|earliest|oldest|initial|originally|began|started)\b/i;
  const latestNewestMatch = /\b(latest|most recent|newest|last time|final|current)\b/i;
  if (!temporalPattern) {
    if (firstEarliestMatch.test(q)) {
      temporalPattern = 'ordering';
      orderDirection = 'asc'; // oldest first
    } else if (latestNewestMatch.test(q)) {
      temporalPattern = 'ordering';
      orderDirection = 'desc'; // newest first
    }
  }

  // Generic temporal detection
  if (!temporalPattern) {
    const temporalWords = /\b(when|date|time|day|week|month|year|ago|before|after|during|since|until|earlier)\b/i;
    if (temporalWords.test(q)) {
      temporalPattern = 'generic_temporal';
    }
  }

  return {
    dateFrom,
    dateTo,
    isTemporalQuery: !!temporalPattern,
    temporalPattern,
    ...(orderDirection ? { orderDirection } : {}),
  };
}

/**
 * Compute a temporal proximity boost for a memory relative to a reference date.
 * Memories closer in time to the reference get a higher boost.
 * @param {string} memoryDate - ISO date of the memory (created_at or session date)
 * @param {string} referenceDate - ISO date to measure proximity against
 * @param {number} [halfLifeDays=30] - Days at which boost halves
 * @returns {number} Boost multiplier (1.0 to ~2.0)
 */
export function temporalProximityBoost(memoryDate, referenceDate, halfLifeDays = 30) {
  if (!memoryDate || !referenceDate) return 1.0;

  const memTime = new Date(memoryDate).getTime();
  const refTime = new Date(referenceDate).getTime();
  if (isNaN(memTime) || isNaN(refTime)) return 1.0;

  const daysDiff = Math.abs(refTime - memTime) / (1000 * 60 * 60 * 24);
  // Exponential decay: boost = 1 + exp(-daysDiff / halfLife)
  const boost = 1 + Math.exp(-daysDiff / halfLifeDays);
  return +boost.toFixed(4);
}
