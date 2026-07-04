import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatTemplateKwargs } from '../src/services/llm/openai.js';

const original = process.env.LLM_CHAT_TEMPLATE_KWARGS;
afterEach(() => {
  if (original === undefined) delete process.env.LLM_CHAT_TEMPLATE_KWARGS;
  else process.env.LLM_CHAT_TEMPLATE_KWARGS = original;
});

describe('parseChatTemplateKwargs', () => {
  it('returns null when unset', () => {
    delete process.env.LLM_CHAT_TEMPLATE_KWARGS;
    assert.equal(parseChatTemplateKwargs(), null);
  });

  it('parses a JSON object', () => {
    process.env.LLM_CHAT_TEMPLATE_KWARGS = '{"enable_thinking": false}';
    assert.deepEqual(parseChatTemplateKwargs(), { enable_thinking: false });
  });

  it('ignores a non-object JSON value', () => {
    process.env.LLM_CHAT_TEMPLATE_KWARGS = '[1,2,3]';
    assert.equal(parseChatTemplateKwargs(), null);
  });

  it('ignores malformed JSON', () => {
    process.env.LLM_CHAT_TEMPLATE_KWARGS = '{not json';
    assert.equal(parseChatTemplateKwargs(), null);
  });
});
