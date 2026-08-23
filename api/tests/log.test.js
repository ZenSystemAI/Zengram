import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorSummary, logError } from '../src/lib/log.js';

describe('errorSummary', () => {
  it('omits Error.message so DSNs and API keys never reach logs', () => {
    const err = new Error('password=hunter2 postgres://user:secret@localhost:5432/zengram');
    err.name = 'error';
    err.code = 'ECONNREFUSED';
    const summary = errorSummary(err);
    assert.equal(summary, 'error ECONNREFUSED');
    assert.equal(summary.includes('secret'), false);
    assert.equal(summary.includes('hunter2'), false);
    assert.equal(summary.includes('postgres://'), false);
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
  it('uses a constant format string and does not print the error message', () => {
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
    assert.equal(summary, 'Error 28P01');
  });
});
