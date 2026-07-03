import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenAiTruncated } from '../src/services/llm/openai.js';
import { isAnthropicTruncated } from '../src/services/llm/anthropic.js';
import { isGeminiTruncated } from '../src/services/llm/gemini.js';
import { isOllamaTruncated } from '../src/services/llm/ollama.js';

describe('provider truncation detectors', () => {
  it('openai: finish_reason=length is truncated', () => {
    assert.equal(isOpenAiTruncated({ choices: [{ finish_reason: 'length' }] }), true);
    assert.equal(isOpenAiTruncated({ choices: [{ finish_reason: 'stop' }] }), false);
    assert.equal(isOpenAiTruncated({}), false);
    assert.equal(isOpenAiTruncated(null), false);
  });

  it('anthropic: stop_reason=max_tokens is truncated', () => {
    assert.equal(isAnthropicTruncated({ stop_reason: 'max_tokens' }), true);
    assert.equal(isAnthropicTruncated({ stop_reason: 'end_turn' }), false);
    assert.equal(isAnthropicTruncated({}), false);
    assert.equal(isAnthropicTruncated(undefined), false);
  });

  it('gemini: candidates[0].finishReason=MAX_TOKENS is truncated', () => {
    assert.equal(isGeminiTruncated({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), true);
    assert.equal(isGeminiTruncated({ candidates: [{ finishReason: 'STOP' }] }), false);
    assert.equal(isGeminiTruncated({ candidates: [] }), false);
    assert.equal(isGeminiTruncated({}), false);
  });

  it('ollama: done_reason=length is truncated', () => {
    assert.equal(isOllamaTruncated({ done_reason: 'length' }), true);
    assert.equal(isOllamaTruncated({ done_reason: 'stop' }), false);
    assert.equal(isOllamaTruncated({}), false);
    assert.equal(isOllamaTruncated(null), false);
  });
});
