// Verifies DELETE /collections/:name is gated behind operator_approved=true and
// returns a clear 403 without it — an agent can't hard-delete a collection
// unprompted. The 403 short-circuits before any DB access, so this is a pure
// route test with no live Postgres.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { collectionsRouter } from '../src/routes/collections.js';

let server, baseUrl;

describe('DELETE /collections/:name operator-approval gate', () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/collections', collectionsRouter);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  it('returns 403 when operator_approved is missing', async () => {
    const res = await fetch(`${baseUrl}/collections/brain_acme`, { method: 'DELETE' });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /operator_approved/);
  });

  it('rejects deleting the default collection even when approved', async () => {
    const res = await fetch(`${baseUrl}/collections/shared_memories?operator_approved=true`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /default collection/);
  });
});
