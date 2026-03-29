// Temporal resolver: detects time references in queries and converts to date ranges.
// Used by the search handler to add temporal filtering and boost.

/**
 * Detect temporal patterns in a query and resolve to date ranges.
 * @param {string} query - The search query
 * @param {string} [referenceDate] - ISO date to resolve relative references against (e.g. question_date)
 * @returns {{ dateFrom?: string, dateTo?: string, isTemporalQuery: boolean, temporalPattern?: string }}
 */
export function resolveTemporalQuery(query, referenceDate) {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  if (isNaN(ref.getTime())) return { isTemporalQuery: false };

  const q = query.toLowerCase();
  let dateFrom, dateTo, temporalPattern;

  // "X days/weeks/months/years ago"
  const agoMatch = q.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);
  if (agoMatch) {
    const amount = parseInt(agoMatch[1]);
    const unit = agoMatch[2];
    const from = new Date(ref);
    const to = new Date(ref);

    if (unit === 'day') {
      from.setDate(from.getDate() - amount - 3); // ±3 day buffer
      to.setDate(to.getDate() - amount + 3);
    } else if (unit === 'week') {
      from.setDate(from.getDate() - (amount * 7) - 7);
      to.setDate(to.getDate() - (amount * 7) + 7);
    } else if (unit === 'month') {
      from.setMonth(from.getMonth() - amount - 1);
      to.setMonth(to.getMonth() - amount + 1);
    } else if (unit === 'year') {
      from.setFullYear(from.getFullYear() - amount - 1);
      to.setFullYear(to.getFullYear() - amount + 1);
    }

    dateFrom = from.toISOString();
    dateTo = to.toISOString();
    temporalPattern = 'relative_ago';
  }

  // "last week/month/year"
  const lastMatch = q.match(/last\s+(week|month|year)/i);
  if (!temporalPattern && lastMatch) {
    const unit = lastMatch[1];
    const from = new Date(ref);
    const to = new Date(ref);

    if (unit === 'week') {
      from.setDate(from.getDate() - 14);
      to.setDate(to.getDate() - 0);
    } else if (unit === 'month') {
      from.setMonth(from.getMonth() - 2);
    } else if (unit === 'year') {
      from.setFullYear(from.getFullYear() - 2);
    }

    dateFrom = from.toISOString();
    dateTo = to.toISOString();
    temporalPattern = 'last_period';
  }

  // "in January/February/.../December" or "in Jan/Feb/..."
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const monthMatch = q.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
  if (!temporalPattern && monthMatch) {
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

  // "between X and Y" — too complex for regex, skip for now

  // Ordering/sequence detection (doesn't produce a date range, but signals temporal need)
  const orderingPattern = /\b(first|earliest|latest|most recent|before|after|order|chronological|oldest|newest)\b/i;
  if (!temporalPattern && orderingPattern.test(q)) {
    temporalPattern = 'ordering';
  }

  // Generic temporal detection
  if (!temporalPattern) {
    const temporalWords = /\b(when|date|time|day|week|month|year|ago|before|after|during|since|until|recently|yesterday|today|earlier)\b/i;
    if (temporalWords.test(q)) {
      temporalPattern = 'generic_temporal';
    }
  }

  return {
    dateFrom,
    dateTo,
    isTemporalQuery: !!temporalPattern,
    temporalPattern,
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
