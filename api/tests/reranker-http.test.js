import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRerankResponse } from '../src/services/reranker/http.js';

// The HTTP reranker client must normalize the response shapes of every common
// self-hosted reranker server into [{index, score}].

describe('parseRerankResponse — server shape normalization', () => {
  it('parses TEI bare-array {index, score}', () => {
    const out = parseRerankResponse([
      { index: 2, score: 0.91 },
      { index: 0, score: 0.40 },
      { index: 1, score: 0.12 },
    ]);
    assert.deepEqual(out, [
      { index: 2, score: 0.91 },
      { index: 0, score: 0.40 },
      { index: 1, score: 0.12 },
    ]);
  });

  it('parses Cohere/Jina/Infinity/vLLM {results:[{index, relevance_score}]}', () => {
    const out = parseRerankResponse({
      results: [
        { index: 1, relevance_score: 0.88 },
        { index: 0, relevance_score: 0.22 },
      ],
    });
    assert.deepEqual(out, [
      { index: 1, score: 0.88 },
      { index: 0, score: 0.22 },
    ]);
  });

  it('reads nested document.index when present', () => {
    const out = parseRerankResponse({
      results: [{ document: { index: 3 }, relevance_score: 0.7 }],
    });
    assert.deepEqual(out, [{ index: 3, score: 0.7 }]);
  });

  it('skips rows missing index or score but keeps valid ones', () => {
    const out = parseRerankResponse({
      results: [
        { index: 0, relevance_score: 0.5 },
        { relevance_score: 0.9 }, // no index → skipped
        { index: 2 },             // no score → skipped
      ],
    });
    assert.deepEqual(out, [{ index: 0, score: 0.5 }]);
  });

  it('throws on a shape with no usable rows', () => {
    assert.throws(() => parseRerankResponse({ foo: 'bar' }), /unexpected shape/);
    assert.throws(() => parseRerankResponse({ results: [{ foo: 1 }] }), /no usable/);
  });
});
