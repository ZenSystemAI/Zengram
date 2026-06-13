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
