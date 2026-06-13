// Verifies /research is OFF by default (no RESEARCH_ENABLED) and returns a clear
// 503 instead of running the loop. Separate file so it loads the route module in
// a process where RESEARCH_ENABLED is unset (the flag is read at import time).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { researchRouter } from '../src/routes/research.js';

let server, baseUrl;

describe('/research disabled by default', () => {
  before(async () => {
    delete process.env.RESEARCH_ENABLED;
    const app = express();
    app.use(express.json());
    app.use('/research', researchRouter);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  it('returns 503 research_disabled when RESEARCH_ENABLED is not set', async () => {
    const res = await fetch(`${baseUrl}/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'anything' }),
    });
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'research_disabled');
  });
});
