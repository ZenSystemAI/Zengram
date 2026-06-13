// Pure helpers for the /research agentic-retrieval loop: parse the LLM's
// sufficiency-gate and synthesis JSON, derive the next gap-targeted query, and
// ground the final answer's [mem:<id>] citations. Kept side-effect-free so the
// loop logic in routes/research.js is the only part that needs a live LLM/DB.

import { extractReflectionJson, extractCitations } from './reflect-utils.js';

/**
 * Parse an LLM JSON response (tolerates code fences / chatter via the shared
 * balanced-brace extractor). Throws on non-object output.
 */
export function parseResearchJson(responseText) {
  let parsed;
  try {
    parsed = JSON.parse(extractReflectionJson(responseText));
  } catch {
    throw new Error('invalid JSON from research LLM');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('non-object JSON from research LLM');
  }
  return parsed;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.trim()).map(s => s.trim());
}

/**
 * Normalize the sufficiency-gate output. Anything that isn't an explicit
 * SUFFICIENT is treated as INSUFFICIENT (fail-safe toward gathering more), and
 * a malformed/empty gate must not crash the loop.
 * @returns {{ status: 'SUFFICIENT'|'INSUFFICIENT', reason: string, missing: string[], draft: string }}
 */
export function normalizeSufficiency(parsed = {}) {
  const status = String(parsed.status || '').trim().toUpperCase() === 'SUFFICIENT'
    ? 'SUFFICIENT' : 'INSUFFICIENT';
  return {
    status,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
    missing: stringArray(parsed.missing),
    draft: typeof parsed.draft === 'string' ? parsed.draft.trim() : '',
  };
}

/**
 * Build the next retrieval query from the named gap. The gap IS the
 * decomposition — no separate planner. Returns '' when there's nothing new to
 * search for (caller then stops the loop).
 */
export function buildGapQuery(sufficiency) {
  if (sufficiency.missing && sufficiency.missing.length) {
    return sufficiency.missing.join('; ').slice(0, 400);
  }
  return (sufficiency.reason || '').slice(0, 400);
}

/**
 * The agentic retrieve → judge → gap-requery loop, with I/O injected so it can be
 * unit-tested without a DB or LLM. The route supplies `retrieve` (multi-path
 * search) and `judge` (the sufficiency-gate LLM call); this owns the control flow:
 * dedup-accumulate, stop on SUFFICIENT (or an explicit `stop`), otherwise turn the
 * named gap into the next query (the gap IS the decomposition), bounded by maxIters.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {number} opts.maxIters
 * @param {(query: string) => Promise<{memories: Array, vectorError?: any}>} opts.retrieve
 * @param {(memories: Array) => Promise<{status: string, reason?: string, missing?: string[], stop?: boolean}>} opts.judge
 * @returns {Promise<{memories: Array, iterations: number, queryTrace: Array, lastGate: object|null, anyVectorError: boolean}>}
 */
export async function runResearchLoop({ question, maxIters, retrieve, judge }) {
  const accumulated = new Map(); // id -> memory (deduped across iterations)
  const triedQueries = new Set([question.toLowerCase()]);
  const queryTrace = [];
  let query = question;
  let lastGate = null;
  let iterations = 0;
  let anyVectorError = false;

  for (let i = 0; i < maxIters; i++) {
    iterations++;

    const { memories, vectorError } = await retrieve(query);
    if (vectorError) anyVectorError = true;
    for (const m of memories) accumulated.set(m.id, m);
    queryTrace.push({ query, retrieved: memories.length, cumulative: accumulated.size });

    if (accumulated.size === 0) break; // nothing anywhere yet — don't ask the gate

    lastGate = await judge([...accumulated.values()]);
    if (lastGate.status === 'SUFFICIENT' || lastGate.stop) break;

    const nextQuery = buildGapQuery(lastGate);
    if (!nextQuery.trim() || triedQueries.has(nextQuery.toLowerCase())) break;
    triedQueries.add(nextQuery.toLowerCase());
    query = nextQuery;
  }

  return { memories: [...accumulated.values()], iterations, queryTrace, lastGate, anyVectorError };
}

/**
 * Ground the final synthesis: validate inline [mem:<id>] citations in `answer`
 * and `key_findings` against the retrieved ids, drop fabricated ones, and
 * surface the deduped cited-id set.
 * @param {object} synth   { answer, key_findings, unresolved }
 * @param {string[]} validIds
 */
export function groundResearchSynthesis(synth = {}, validIds = []) {
  const idSet = new Set(validIds);
  const cited = [];
  const collect = (ids) => { for (const id of ids) if (!cited.includes(id)) cited.push(id); };

  const answerRes = extractCitations(typeof synth.answer === 'string' ? synth.answer : '', idSet);
  collect(answerRes.citedIds);

  const keyFindings = stringArray(synth.key_findings).map(entry => {
    const { text, citedIds } = extractCitations(entry, idSet);
    collect(citedIds);
    return text;
  });

  return {
    answer: answerRes.text,
    key_findings: keyFindings,
    unresolved: stringArray(synth.unresolved),
    cited_memory_ids: cited,
  };
}
