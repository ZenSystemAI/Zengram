import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReflectionJson,
  noRelevantMemoriesReflection,
  normalizeReflectionPayload,
  parseReflectionResponse,
  attachReflectionCitations,
  extractCitations,
  reflectRetrievalMetadata,
  reflectUnavailableResponse,
} from '../src/services/reflect-utils.js';

describe('reflect-utils', () => {
  it('builds a no-memory reflection without implying retrieval failure', () => {
    const response = noRelevantMemoriesReflection('alpha shared brain', 'global');
    assert.equal(response.topic, 'alpha shared brain');
    assert.equal(response.client_id, 'global');
    assert.equal(response.memories_analyzed, 0);
    assert.equal(response.llm, null);
    assert.deepEqual(response.reflection.patterns, []);
  });

  it('marks reflect retrieval as degraded when vector search is unavailable', () => {
    const metadata = reflectRetrievalMetadata({
      useMultiPath: true,
      vectorFailed: true,
      keywordCount: 3,
      keywordQuery: 'alpha brain',
    });

    assert.equal(metadata.degraded, true);
    assert.equal(metadata.reason, 'vector_search_unavailable');
    assert.equal(metadata.keyword_query, 'alpha brain');
    assert.deepEqual(metadata.paths, { vector: 'failed', keyword: 3 });
  });

  it('returns 503 payload metadata for reflection retrieval outages', () => {
    const response = reflectUnavailableResponse('alpha', true, 0);
    assert.match(response.error, /Reflection unavailable/);
    assert.equal(response.retrieval.reason, 'vector_search_unavailable');
    assert.deepEqual(response.retrieval.paths, { vector: 'failed', keyword: 0 });
  });

  it('extracts reflection JSON from fenced or chattery local-model output', () => {
    assert.equal(
      extractReflectionJson('```json\n{"summary":"ok","patterns":[]}\n```'),
      '{"summary":"ok","patterns":[]}'
    );
    assert.equal(
      extractReflectionJson('Here is the synthesis:\n{"summary":"ok {still string}","patterns":[]}\nDone.'),
      '{"summary":"ok {still string}","patterns":[]}'
    );
  });

  it('parses and normalizes reflection payloads', () => {
    assert.deepEqual(parseReflectionResponse('{"summary":"ok","patterns":["p",7],"timeline":[],"contradictions":[],"gaps":["g"]}'), {
      summary: 'ok',
      patterns: ['p'],
      timeline: [],
      contradictions: [],
      gaps: ['g'],
    });
    assert.deepEqual(normalizeReflectionPayload({ summary: 42, patterns: 'bad' }), {
      summary: '',
      patterns: [],
      timeline: [],
      contradictions: [],
      gaps: [],
    });
  });

  it('rejects non-object reflection JSON and invalid array fields', () => {
    assert.throws(() => parseReflectionResponse('[]'), /non-object JSON/);
    assert.throws(() => parseReflectionResponse('{"summary":"ok","patterns":"bad"}'), /patterns must be an array/);
  });

  it('keeps valid [mem:id] citations and strips fabricated ones', () => {
    const ids = new Set(['abc-123', 'def-456']);
    const kept = extractCitations('Pattern X [mem:abc-123]', ids);
    assert.equal(kept.text, 'Pattern X [mem:abc-123]');
    assert.deepEqual(kept.citedIds, ['abc-123']);

    const stripped = extractCitations('Pattern Y [mem:ghost-999]', ids);
    assert.equal(stripped.text, 'Pattern Y');
    assert.deepEqual(stripped.citedIds, []);

    const mixed = extractCitations('Pattern Z [mem:abc-123] [mem:ghost-999] [mem:def-456]', ids);
    assert.equal(mixed.text, 'Pattern Z [mem:abc-123] [mem:def-456]');
    assert.deepEqual(mixed.citedIds, ['abc-123', 'def-456']);
  });

  it('grounds a reflection and surfaces the deduped cited-id set', () => {
    const reflection = normalizeReflectionPayload({
      summary: 'ok',
      patterns: ['P1 [mem:a]', 'P2 [mem:b] [mem:fake]'],
      timeline: ['T1 [mem:a]'],
      contradictions: [],
      gaps: ['G1'],
    });
    const { reflection: grounded, cited_memory_ids } = attachReflectionCitations(reflection, ['a', 'b']);
    assert.deepEqual(grounded.patterns, ['P1 [mem:a]', 'P2 [mem:b]']);
    assert.deepEqual(grounded.timeline, ['T1 [mem:a]']);
    assert.deepEqual(grounded.gaps, ['G1']); // untouched, no citations required
    assert.deepEqual(cited_memory_ids, ['a', 'b']);
  });
});
