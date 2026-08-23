import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { errorSummary, logError } from '../src/lib/log.js';

function expectedFingerprint(err) {
  return crypto
    .createHash('sha256')
    .update(err.name)
    .update('\0')
    .update(String(err.code ?? ''))
    .update('\0')
    .update(err.message)
    .digest('hex')
    .slice(0, 12);
}

describe('errorSummary', () => {
  it('returns a hash fingerprint and never the Error.message', () => {
    const err = new Error('password=hunter2 postgres://user:secret@localhost:5432/zengram');
    err.name = 'error';
    err.code = 'ECONNREFUSED';
    const summary = errorSummary(err);
    assert.equal(summary, expectedFingerprint(err));
    assert.match(summary, /^[0-9a-f]{12}$/);
    assert.equal(summary.includes('secret'), false);
    assert.equal(summary.includes('hunter2'), false);
    assert.equal(summary.includes('postgres://'), false);
    assert.equal(summary.includes('ECONNREFUSED'), false);
  });

  it('is stable for the same error', () => {
    const err = new Error('same');
    err.code = 'ETIMEDOUT';
    assert.equal(errorSummary(err), errorSummary(err));
  });

  it('does not echo a raw string (callers must pass the Error, not err.message)', () => {
    assert.equal(errorSummary('sk-live-super-secret'), 'Error');
  });

  it('returns Error for nullish values', () => {
    assert.equal(errorSummary(null), 'Error');
    assert.equal(errorSummary(undefined), 'Error');
  });
});

describe('logError', () => {
  it('uses a constant format string and logs only the fingerprint', () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      const err = new Error('password=hunter2 postgres://u:p@h/db');
      err.code = '28P01';
      logError({ requestId: '%s%s%s injected' }, '[test]', err);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    const [fmt, id, tag, summary] = logged[0];
    assert.equal(fmt, '[%s] %s %s');
    assert.equal(id, '%s%s%s injected');
    assert.equal(tag, '[test]');
    assert.match(summary, /^[0-9a-f]{12}$/);
    assert.equal(String(summary).includes('hunter2'), false);
  });
});
