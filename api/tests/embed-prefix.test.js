import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvEscapes } from '../src/services/embedders/interface.js';

describe('decodeEnvEscapes (env-file prefix newlines)', () => {
  it('turns a literal \\n into a real newline', () => {
    assert.equal(
      decodeEnvEscapes('Instruct: Given a web search query, retrieve relevant passages that answer the query\\nQuery: '),
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: '
    );
  });
  it('decodes \\t and leaves other text intact', () => {
    assert.equal(decodeEnvEscapes('a\\tb\\nc'), 'a\tb\nc');
    assert.equal(decodeEnvEscapes('no escapes here'), 'no escapes here');
  });
  it('handles empty / undefined', () => {
    assert.equal(decodeEnvEscapes(''), '');
    assert.equal(decodeEnvEscapes(undefined), '');
  });
  it('strips one surrounding quote pair, preserving significant trailing whitespace', () => {
    // Secret managers trim bare trailing spaces; quoting protects them.
    assert.equal(decodeEnvEscapes('"Instruct: task\\nQuery: "'), 'Instruct: task\nQuery: ');
    assert.equal(decodeEnvEscapes('"a"'), 'a');
    // Only a full surrounding pair is stripped — interior quotes are content.
    assert.equal(decodeEnvEscapes('say "hi" now'), 'say "hi" now');
    assert.equal(decodeEnvEscapes('"unterminated'), '"unterminated');
    assert.equal(decodeEnvEscapes('"'), '"');
  });
});
