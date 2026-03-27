import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function createRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}

async function loadRateLimit() {
  process.env.RATE_LIMIT_READS = '1';
  process.env.RATE_LIMIT_WRITES = '1';
  const mod = await import(`../src/middleware/ratelimit.js?case=${Date.now()}-${Math.random()}`);
  return mod.rateLimitMiddleware;
}

describe('rateLimitMiddleware', () => {
  test('uses req.rateLimitKey for bucketing', async () => {
    const rateLimitMiddleware = await loadRateLimit();

    const req1 = { method: 'GET', path: '/memory/search', headers: {}, query: {}, rateLimitKey: 'agent-a' };
    const res1 = createRes();
    let next1 = false;
    rateLimitMiddleware(req1, res1, () => { next1 = true; });
    assert.equal(next1, true);

    const req2 = { method: 'GET', path: '/memory/search', headers: {}, query: {}, rateLimitKey: 'agent-a' };
    const res2 = createRes();
    rateLimitMiddleware(req2, res2, () => {});
    assert.equal(res2.statusCode, 429);

    const req3 = { method: 'GET', path: '/memory/search', headers: {}, query: {}, rateLimitKey: 'agent-b' };
    const res3 = createRes();
    let next3 = false;
    rateLimitMiddleware(req3, res3, () => { next3 = true; });
    assert.equal(next3, true);
  });
});
