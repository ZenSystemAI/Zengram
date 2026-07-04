const REFLECTION_ARRAY_FIELDS = ['patterns', 'timeline', 'contradictions', 'gaps'];

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

export function extractReflectionJson(responseText) {
  let jsonText = String(responseText ?? '').trim();
  // Reasoning models (Qwen 3.x and similar) can leak <think> blocks ahead of
  // the JSON; their contents often include draft braces that would fool
  // extractBalancedObject. An unclosed <think> means the answer never came.
  jsonText = jsonText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const unclosedThink = jsonText.search(/<think>/i);
  if (unclosedThink !== -1) jsonText = jsonText.slice(0, unclosedThink).trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  return extractBalancedObject(jsonText).trim();
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string');
}

export function normalizeReflectionPayload(payload = {}) {
  return {
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    patterns: stringArray(payload.patterns),
    timeline: stringArray(payload.timeline),
    contradictions: stringArray(payload.contradictions),
    gaps: stringArray(payload.gaps),
  };
}

export function parseReflectionResponse(responseText) {
  let parsed;
  try {
    parsed = JSON.parse(extractReflectionJson(responseText));
  } catch {
    throw new Error('invalid JSON from reflection LLM');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('non-object JSON from reflection LLM');
  }

  for (const field of REFLECTION_ARRAY_FIELDS) {
    if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
      throw new Error(`invalid reflection LLM schema: ${field} must be an array`);
    }
  }

  return normalizeReflectionPayload(parsed);
}

const CITATION_TOKEN = /\[mem:([^\]\s]+)\]/g;
const CITED_TEXT_FIELDS = ['patterns', 'timeline', 'contradictions'];

/**
 * Scan a string for [mem:<id>] citation tokens. Keep tokens whose id is in
 * `validIds`; strip tokens that reference a memory not actually retrieved (an
 * LLM-fabricated citation). Returns the cleaned text plus the set of valid
 * cited ids found.
 * @param {string} text
 * @param {Set<string>} validIds
 * @returns {{ text: string, citedIds: string[] }}
 */
export function extractCitations(text, validIds) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', citedIds: [] };
  const citedIds = [];
  const cleaned = text.replace(CITATION_TOKEN, (token, id) => {
    if (validIds.has(id)) {
      if (!citedIds.includes(id)) citedIds.push(id);
      return token;
    }
    return ''; // drop fabricated citation
  }).replace(/[ \t]{2,}/g, ' ').replace(/\s+$/g, '');
  return { text: cleaned, citedIds };
}

/**
 * Ground a parsed reflection: validate inline [mem:<id>] citations in the
 * patterns/timeline/contradictions entries against the ids actually retrieved,
 * dropping any fabricated ones, and surface the deduped set of cited ids.
 * Shape of `reflection` is preserved (string arrays).
 * @param {object} reflection  Output of parseReflectionResponse.
 * @param {string[]} validIds  Ids of the memories fed to the LLM.
 * @returns {{ reflection: object, cited_memory_ids: string[] }}
 */
export function attachReflectionCitations(reflection, validIds = []) {
  const idSet = new Set(validIds);
  const grounded = { ...reflection };
  const allCited = [];

  for (const field of CITED_TEXT_FIELDS) {
    if (!Array.isArray(reflection[field])) continue;
    grounded[field] = reflection[field].map(entry => {
      const { text, citedIds } = extractCitations(entry, idSet);
      for (const id of citedIds) if (!allCited.includes(id)) allCited.push(id);
      return text;
    });
  }

  return { reflection: grounded, cited_memory_ids: allCited };
}

export function noRelevantMemoriesReflection(topic, clientId = null) {
  return {
    topic,
    client_id: clientId,
    memories_analyzed: 0,
    reflection: {
      summary: 'No relevant memories found for this topic.',
      patterns: [],
      timeline: [],
      contradictions: [],
      gaps: ['No memories exist about this topic -- consider storing foundational context.'],
    },
    llm: null,
  };
}

export function reflectUnavailableResponse(topic, useMultiPath, keywordCount = 0, { keywordQuery } = {}) {
  return {
    error: 'Reflection unavailable: vector embedding/search failed and keyword fallback could not provide memories',
    topic,
    retrieval: reflectRetrievalMetadata({
      useMultiPath,
      vectorFailed: true,
      keywordCount,
      keywordQuery,
    }),
  };
}

export function reflectRetrievalMetadata({
  useMultiPath,
  vectorFailed = false,
  vectorCount = 0,
  keywordCount = 0,
  keywordQuery,
} = {}) {
  return {
    multi_path: useMultiPath,
    degraded: vectorFailed,
    ...(vectorFailed ? { reason: 'vector_search_unavailable' } : {}),
    ...(keywordQuery ? { keyword_query: keywordQuery } : {}),
    paths: useMultiPath ? {
      vector: vectorFailed ? 'failed' : vectorCount,
      keyword: keywordCount,
    } : {
      vector: vectorFailed ? 'failed' : vectorCount,
    },
  };
}
