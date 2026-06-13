import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsToolCallControlMarkup,
  validateNoToolCallControlMarkup,
  validateContent,
  validateMemoryInput,
} from '../src/middleware/validate.js';

describe('tool-call control-markup guard', () => {
  it('detects tool-call control markup in strings', () => {
    assert.equal(containsToolCallControlMarkup('hello <tool_call>'), true);
    assert.equal(containsToolCallControlMarkup('use </function> here'), true);
    assert.equal(containsToolCallControlMarkup('<parameters>'), true);
    // plain prose that merely mentions the words is fine (no opening angle bracket)
    assert.equal(containsToolCallControlMarkup('a memory about functions and parameters'), false);
  });

  it('detects markup nested in objects, arrays, and keys', () => {
    assert.equal(containsToolCallControlMarkup({ a: { b: '<arguments>' } }), true);
    assert.equal(containsToolCallControlMarkup({ '<tool_call>': 'x' }), true);
    assert.equal(containsToolCallControlMarkup({ a: ['ok', '<args>'] }), true);
    assert.equal(containsToolCallControlMarkup({ a: 'clean', b: ['also clean'] }), false);
  });

  it('returns an error message from validateNoToolCallControlMarkup', () => {
    assert.match(validateNoToolCallControlMarkup('<tool_call>', 'content'), /tool-call control markup/);
    assert.equal(validateNoToolCallControlMarkup('clean text', 'content'), null);
  });

  it('validateContent rejects markup but accepts clean content', () => {
    assert.match(validateContent('do <function> this'), /tool-call control markup/);
    assert.equal(validateContent('a clean memory'), null);
  });

  it('validateMemoryInput rejects markup by default', () => {
    assert.match(
      validateMemoryInput({ type: 'event', content: 'has <args> markup', source_agent: 'claude-code' }),
      /tool-call control markup/
    );
  });

  it('trusted paths can bypass the guard via allowToolCallControlMarkup', () => {
    assert.equal(validateContent('<tool_call>restore', { allowToolCallControlMarkup: true }), null);
    assert.equal(
      validateMemoryInput(
        { type: 'event', content: '<tool_call>', source_agent: 'import' },
        { allowToolCallControlMarkup: true }
      ),
      null
    );
  });
});
