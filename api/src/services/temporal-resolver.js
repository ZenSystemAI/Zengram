// Temporal resolver: detects time references in queries and converts to date ranges.
// Used by the search handler to add temporal filtering and boost.
//
// v2.5.1 — Added "yesterday", "today", "this week/month/year", "recently" patterns.
// Added ordering direction for first/earliest/latest queries.
// Tightened "last month/year" ranges (were too wide).

/**
 * Detect temporal patterns in a query and resolve to date ranges.
 * @param {string} query - The search query
 * @param {string} [referenceDate] - ISO date to resolve relative references against (e.g. question_date)
 * @returns {{ dateFrom?: string, dateTo?: string, isTemporalQuery: boolean, temporalPattern?: string, orderDirection?: 'asc'|'desc' }}
 */
export function resolveTemporalQuery(query, referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  if (isNaN(ref.getTime())) return { isTemporalQuery: false };

  const q = query.toLowerCase();
  let dateFrom, dateTo, temporalPattern, orderDirection;

  // "yesterday"
  if (!temporalPattern && /\byesterday\b/i.test(q)) {
    const from = new Date(ref);
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    dateFrom = from.toISOString();
    dateTo = to.toISOString();
    temporalPattern = 'yesterday';
  }

  // "today"
  if (!temporalPattern && /\btoday\b/i.test(q)) {
    const from = new Date(ref);
    from.setHours(0, 0, 0, 0);
    dateFrom = from.toISOString();
    dateTo = ref.toISOString();
    temporalPattern = 'today';
  }

  // "X days/weeks/months/years ago"
  const agoMatch = !temporalPattern && q.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);
  if (agoMatch) {
    const amount = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    const from = new Date(ref);
    const to = new Date(ref);

    if (unit === 'day') {
      from.setDate(from.getDate() - amount - 2); // ±2 day buffer
      to.setDate(to.getDate() - amount + 2);
    } else if (unit === 'week') {
      from.setDate(from.getDate() - (amount * 7) - 5);
      to.setDate(to.getDate() - (amount * 7) + 5);
    } else if (unit === 'month') {
      from.setMonth(from.getMonth() - amount);
      from.setDate(1); // start of that month
      to.setMonth(to.getMonth() - amount + 1);
      to.setDate(0); // end of that month
    } else if (unit === 'year') {
      from.setFullYear(from.getFullYear() - amount, 0, 1);
      to.setFullYear(to.getFullYear() - amount, 11, 31);
    }

    dateFrom = from.toISOString();
    dateTo = to.toISOString();
    temporalPattern = 'relative_ago';
  }

  // "this week/month/year"
  const thisMatch = !temporalPattern && q.match(/\bthis\s+(week|month|year)\b/i);
  if (thisMatch) {
    const unit = thisMatch[1];
    const from = new Date(ref);

    if (unit === 'week') {
      const day = from.getDay();
      from.setDate(from.getDate() - (day === 0 ? 6 : day - 1)); // Monday
      from.setHours(0, 0, 0, 0);
    } else if (unit === 'month') {
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
    } else if (unit === 'year') {
      from.setMonth(0, 1);
      from.setHours(0, 0, 0, 0);
    }

    dateFrom = from.toISOString();
    dateTo = ref.toISOString();
    temporalPattern = 'this_period';
  }

  // "last week/month/year"
  const lastMatch = !temporalPattern && q.match(/\blast\s+(week|month|year)\b/i);
  if (lastMatch) {
    const unit = lastMatch[1];
    const from = new Date(ref);
    const to = new Date(ref);

    if (unit === 'week') {
      // Last 7-14 days
      from.setDate(from.getDate() - 14);
      to.setDate(to.getDate() - 0);
    } else if (unit === 'month') {
      // Previous calendar month + buffer
      from.setMonth(from.getMonth() - 1, 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(0); // last day of previous month
      to.setHours(23, 59, 59, 999);
      // Add 5 days buffer on each side
      from.setDate(from.getDate() - 5);
      to.setDate(to.getDate() + 5);
    } else if (unit === 'year') {
      from.setFullYear(from.getFullYear() - 1, 0, 1);
      to.setFullYear(to.getFullYear() - 1, 11, 31);
      to.setHours(23, 59, 59, 999);
    }

    dateFrom = from.toISOString();
    dateTo = to.toISOString();
    temporalPattern = 'last_period';
  }

  // "recently" / "recent" — last 2 weeks
  if (!temporalPattern && /\b(recently|recent)\b/i.test(q)) {
    const from = new Date(ref);
    from.setDate(from.getDate() - 14);
    dateFrom = from.toISOString();
    dateTo = ref.toISOString();
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
      // Assume the most recent occurrence of that month
      const from = new Date(ref);
      from.setMonth(monthIdx, 1);
      from.setHours(0, 0, 0, 0);
      if (from > ref) from.setFullYear(from.getFullYear() - 1);

      const to = new Date(from);
      to.setMonth(to.getMonth() + 1);

      dateFrom = from.toISOString();
      dateTo = to.toISOString();
      temporalPattern = 'named_month';
    }
  }

  // Ordering/sequence detection — signals that results should be date-sorted
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
