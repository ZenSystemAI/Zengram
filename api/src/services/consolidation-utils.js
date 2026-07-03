// Pure helpers for the consolidation engine: tolerant LLM-output JSON parsing,
// run/job status derivation, and the supersedable-type rule. Kept side-effect
// free so consolidation.js owns all the I/O and this stays unit-testable.

const ARRAY_FIELDS = [
  'merged_facts',
  'contradictions',
  'connections',
  'compressed_summaries',
  'knowledge_categories',
];

export class LlmOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmOutputError';
    this.code = 'llm_output_invalid';
    this.retryable = true;
  }
}

// Brace-depth-aware extractor: pulls the first balanced {...} object out of LLM
// output even when the model appends trailing prose after the JSON (a regex
// fence match alone fails on '{...} here is my reasoning...').
function extractBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return text;
}

export function extractConsolidationJson(responseText) {
  let jsonText = String(responseText ?? '').trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  return extractBalancedObject(jsonText).trim();
}

export function parseConsolidationResponse(responseText) {
  let result;
  try {
    result = JSON.parse(extractConsolidationJson(responseText));
  } catch (e) {
    throw new LlmOutputError('invalid JSON from consolidation LLM');
  }

  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new LlmOutputError('non-object JSON from consolidation LLM');
  }

  for (const field of ARRAY_FIELDS) {
    if (result[field] !== undefined && !Array.isArray(result[field])) {
      throw new LlmOutputError(`invalid consolidation LLM schema: ${field} must be an array`);
    }
  }

  return result;
}

export function isLlmOutputError(err) {
  return err instanceof LlmOutputError || err?.name === 'LlmOutputError';
}

export function consolidationRunStatus(errors = []) {
  return errors.length > 0 ? 'partial' : 'complete';
}

export function consolidationJobStatus(result) {
  return result?.status === 'partial' ? 'partial' : 'complete';
}

// Types whose older memory can be safely auto-superseded when the LLM flags
// a contradiction. Events and decisions are historical records — even when
// later information invalidates them, the audit trail is preserved via the
// CONTRADICTION DETECTED event and the original memory stays active. Facts
// and statuses are current-state assertions; the newer of two contradicting
// ones wins.
const SUPERSEDABLE_TYPES = new Set(['fact', 'status']);
export function isSupersedableType(type) {
  return SUPERSEDABLE_TYPES.has(type);
}

// Decide which of two contradicting memories to keep. Honors the LLM's
// suggested_resolution when it clearly names one memory (by id, by "memory_a"/
// "memory_b" / "first"/"second", or by "newer"/"older"), else falls back to
// "newer wins" by timestamp — the prior behaviour. basis records which rule
// fired so the audit trail can distinguish LLM-directed from automatic supersedes.
export function resolveContradiction({ idA, idB, timeA = 0, timeB = 0, suggestion = '' }) {
  const text = String(suggestion || '').toLowerCase();
  const hasA = idA && text.includes(String(idA).toLowerCase());
  const hasB = idB && text.includes(String(idB).toLowerCase());

  let keep = null;
  if (hasA && !hasB) keep = 'a';
  else if (hasB && !hasA) keep = 'b';
  else {
    const mentionsA = /\bmemory[_ ]?a\b|\bfirst\b/.test(text);
    const mentionsB = /\bmemory[_ ]?b\b|\bsecond\b/.test(text);
    if (mentionsA && !mentionsB) keep = 'a';
    else if (mentionsB && !mentionsA) keep = 'b';
    else {
      const newer = /\bnewer\b|\bmore recent\b|\bmost recent\b|\blatest\b|\blater\b/.test(text);
      const older = /\bolder\b|\bearlier\b|\boriginal\b/.test(text);
      if (newer && !older) keep = timeA >= timeB ? 'a' : 'b';
      else if (older && !newer) keep = timeA <= timeB ? 'a' : 'b';
    }
  }

  let basis = 'suggestion';
  if (keep === null) {
    // Fallback: newer wins — supersede the older memory (timeA<=timeB => a is
    // older-or-equal, keep b). Matches the pre-honor timestamp behaviour.
    keep = timeA <= timeB ? 'b' : 'a';
    basis = 'timestamp';
  }

  return keep === 'a'
    ? { keepId: idA, supersedeId: idB, basis }
    : { keepId: idB, supersedeId: idA, basis };
}

// Cap the per-run consolidation backlog. scrollPoints returns newest-first, so
// reversing yields oldest-first — process the oldest cap memories and report
// how many remain for the next run. Pure so the slicing is unit-testable.
export function selectBacklog(points, cap) {
  const all = Array.isArray(points) ? points : [];
  const oldestFirst = [...all].reverse();
  const limit = Number.isFinite(cap) && cap > 0 ? cap : all.length;
  const selected = oldestFirst.slice(0, limit);
  return { selected, remaining: Math.max(0, all.length - selected.length) };
}

const CONNECTION_CAP = 20;

// Merge connection target ids, dedupe (existing first for stability), and cap.
// Prevents each run from clobbering prior-run connections on a memory.
export function mergeConnections(existing = [], incoming = [], cap = CONNECTION_CAP) {
  const seen = new Set();
  const out = [];
  for (const id of [...(existing || []), ...(incoming || [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}
