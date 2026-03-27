import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function loadAuth({ allowQuery = 'false' } = {}) {
  process.env.BRAIN_API_KEY = 'admin-secret-key';
  process.env.AGENT_KEY_test_agent = 'agent-secret-key';
  process.env.ALLOW_QUERY_API_KEY = allowQuery;
  const mod = await import(`../src/middleware/auth.js?case=${Date.now()}-${Math.random()}`);
  return mod.authMiddleware;
}

describe('authMiddleware', () => {
  test('accepts x-api-key header for admin key', async () => {
    const authMiddleware = await loadAuth({ allowQuery: 'false' });
    const req = {
      headers: { 'x-api-key': 'admin-secret-key' },
      query: {},
      ip: '10.0.0.1',
      socket: { remoteAddress: '10.0.0.1' },
    };
    const res = createRes();
    let called = false;

    authMiddleware(req, res, () => { called = true; });

    assert.equal(called, true);
    assert.equal(req.authenticatedAgent, null);
    assert.equal(req.authSource, 'header');
    assert.equal(req.rateLimitKey, 'admin-secret-key');
  });

  test('accepts bearer token auth', async () => {
    const authMiddleware = await loadAuth({ allowQuery: 'false' });
    const req = {
      headers: { authorization: 'Bearer admin-secret-key' },
      query: {},
      ip: '10.0.0.11',
      socket: { remoteAddress: '10.0.0.11' },
    };
    const res = createRes();
    let called = false;

    authMiddleware(req, res, () => { called = true; });

    assert.equal(called, true);
    assert.equal(req.authSource, 'bearer');
    assert.equal(req.rateLimitKey, 'admin-secret-key');
  });

  test('rejects query key when ALLOW_QUERY_API_KEY=false', async () => {
    const authMiddleware = await loadAuth({ allowQuery: 'false' });
    const req = {
      headers: {},
      query: { key: 'admin-secret-key' },
      ip: '10.0.0.2',
      socket: { remoteAddress: '10.0.0.2' },
    };
    const res = createRes();

    authMiddleware(req, res, () => {});

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Query-string API keys are disabled. Use x-api-key header.' });
  });

  test('accepts query key when ALLOW_QUERY_API_KEY=true', async () => {
    const authMiddleware = await loadAuth({ allowQuery: 'true' });
    const req = {
      headers: {},
      query: { key: 'admin-secret-key' },
      ip: '10.0.0.3',
      socket: { remoteAddress: '10.0.0.3' },
    };
    const res = createRes();
    let called = false;

    authMiddleware(req, res, () => { called = true; });

    assert.equal(called, true);
    assert.equal(req.authSource, 'query');
    assert.equal(req.rateLimitKey, 'admin-secret-key');
  });
});
