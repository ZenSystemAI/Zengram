// Verifies the destructive /export/import restore is gated behind
// operator_approved=true (a clear 403), so an agent can't trigger a restore
// unprompted. The empty-data case proves we pass the gate without touching a DB.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { exportRouter } from '../src/routes/export.js';

let server, baseUrl;

describe('/export/import operator-approval gate', () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/export', exportRouter);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  it('returns 403 when operator_approved is missing', async () => {
    const res = await fetch(`${baseUrl}/export/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ content: 'x', type: 'event' }] }),
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.match(json.error, /operator_approved/);
  });

  it('passes the gate with operator_approved=true (empty data is a no-op)', async () => {
    const res = await fetch(`${baseUrl}/export/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [], operator_approved: true }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.imported, 0);
  });
});
