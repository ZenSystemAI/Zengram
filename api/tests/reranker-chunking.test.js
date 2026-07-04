import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpReranker } from '../src/services/reranker/http.js';

// Simulate a TEI server with a hard 32 client-batch cap (the real default that
// silently broke reranking for 40-candidate pools until chunking was added).
const realFetch = globalThis.fetch;
const savedEnv = {};
const ENV = ['RERANK_URL', 'RERANK_API', 'RERANK_MODEL', 'RERANK_MAX_BATCH', 'RERANK_API_KEY'];

beforeEach(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.RERANK_URL = 'http://fake-tei/rerank';
  process.env.RERANK_API = 'tei';
  process.env.RERANK_MAX_BATCH = '32';
  let maxSeen = 0;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const texts = body.texts; // tei shape
    maxSeen = Math.max(maxSeen, texts.length);
    if (texts.length > 32) {
      return { ok: false, status: 422, text: async () => 'batch size > 32' };
    }
    // score = numeric suffix of "doc <n>" so ordering is checkable
    const rows = texts.map((t, i) => ({ index: i, score: Number(String(t).replace(/\D/g, '')) || 0 }));
    return { ok: true, json: async () => rows };
  };
  globalThis.__maxBatchSeen = () => maxSeen;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('HttpReranker chunking (server batch cap)', () => {
  it('reranks a 40-doc pool by chunking under the 32 cap, with correct merged indices', async () => {
    const r = new HttpReranker();
    const docs = Array.from({ length: 40 }, (_, i) => `doc ${i}`); // score == i
    const out = await r.rerank('q', docs); // no topN → all
    assert.equal(out.length, 40, 'all 40 docs scored despite the 32-cap');
    // highest score (doc 39) first; indices map back to the full list
    assert.equal(out[0].index, 39);
    assert.equal(out[0].score, 39);
    assert.equal(out[out.length - 1].index, 0);
    // every original index present exactly once
    assert.deepEqual([...out.map(o => o.index)].sort((a, b) => a - b), docs.map((_, i) => i));
    // never sent more than the cap in a single request
    assert.ok(globalThis.__maxBatchSeen() <= 32);
  });

  it('respects topN after merging chunks', async () => {
    const r = new HttpReranker();
    const docs = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
    const out = await r.rerank('q', docs, 5);
    assert.equal(out.length, 5);
    assert.deepEqual(out.map(o => o.index), [39, 38, 37, 36, 35]);
  });
});
