import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  withRetry,
  isRetryableError,
  isLlmTruncationError,
  LlmTruncationError,
  LlmHttpError,
  LlmResponseError,
  resolveMaxTokens,
} from '../src/services/llm/retry.js';

const noSleep = async () => {};

describe('isRetryableError', () => {
  it('retries 429 and 5xx HTTP errors', () => {
    assert.equal(isRetryableError(new LlmHttpError(429, '', 'X')), true);
    assert.equal(isRetryableError(new LlmHttpError(500, '', 'X')), true);
    assert.equal(isRetryableError(new LlmHttpError(503, '', 'X')), true);
  });

  it('does not retry other 4xx', () => {
    assert.equal(isRetryableError(new LlmHttpError(400, '', 'X')), false);
    assert.equal(isRetryableError(new LlmHttpError(401, '', 'X')), false);
    assert.equal(isRetryableError(new LlmHttpError(404, '', 'X')), false);
  });

  it('does not retry truncation', () => {
    assert.equal(isRetryableError(new LlmTruncationError('cut off')), false);
    assert.equal(isRetryableError({ truncated: true }), false);
  });

  it('does not retry deterministic bad-shape responses', () => {
    assert.equal(isRetryableError(new LlmResponseError('no candidates')), false);
  });

  it('retries network-level errors with no HTTP status', () => {
    assert.equal(isRetryableError(new Error('socket hang up')), true);
    assert.equal(isRetryableError(new Error('Request timed out after 120000ms')), true);
  });

  it('is false for nullish', () => {
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError(undefined), false);
  });
});

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  it('retries exactly once on a retryable error then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new LlmHttpError(500, 'boom', 'X');
      return 'recovered';
    }, { sleep: noSleep });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2);
  });

  it('gives up after one retry (two attempts total) on persistent failure', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new LlmHttpError(503, 'down', 'X'); }, { sleep: noSleep }),
      (err) => err.status === 503
    );
    assert.equal(calls, 2);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new LlmHttpError(400, 'bad', 'X'); }, { sleep: noSleep }),
      (err) => err.status === 400
    );
    assert.equal(calls, 1);
  });

  it('does not retry a truncation error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new LlmTruncationError('cut off'); }, { sleep: noSleep }),
      (err) => isLlmTruncationError(err)
    );
    assert.equal(calls, 1);
  });

  it('does not retry a deterministic bad-shape response', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new LlmResponseError('no candidates'); }, { sleep: noSleep }),
      (err) => err instanceof LlmResponseError
    );
    assert.equal(calls, 1);
  });

  it('backs off before the retry (sleep called once with a positive delay)', async () => {
    const delays = [];
    const sleep = async (ms) => { delays.push(ms); };
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    }, { sleep, baseMs: 500 });
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 500, `expected backoff >= 500, got ${delays[0]}`);
  });
});

describe('resolveMaxTokens', () => {
  it('prefers an explicit option', () => {
    assert.equal(resolveMaxTokens({ max_tokens: 1234 }), 1234);
  });

  it('falls back to the default when unset', () => {
    // LLM_MAX_TOKENS is not set in the test environment
    assert.equal(resolveMaxTokens({}), 8192);
    assert.equal(resolveMaxTokens({}, 65536), 65536);
  });
});
