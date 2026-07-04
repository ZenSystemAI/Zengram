// MCP tool-response serialization: compact by default, opt-in pretty, and a
// valid JSON truncation envelope when a payload exceeds the char cap. Pure/unit
// — reaches into ../../mcp-server the same way mcp-annotations.test.js does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxToolJsonChars, shouldPrettyPrintToolJson, toolJson } from '../../mcp-server/src/response-format.js';

describe('mcp response-format', () => {
  it('uses compact JSON by default for local-model tool parser safety', () => {
    assert.equal(toolJson({ ok: true, nested: { value: 1 } }, {}), '{"ok":true,"nested":{"value":1}}');
  });

  it('allows pretty JSON when explicitly requested', () => {
    assert.equal(shouldPrettyPrintToolJson({ BRAIN_MCP_PRETTY_JSON: 'true' }), true);
    assert.equal(toolJson({ ok: true }, { BRAIN_MCP_PRETTY_JSON: 'true' }), '{\n  "ok": true\n}');
  });

  it('keeps false-like values compact', () => {
    assert.equal(shouldPrettyPrintToolJson({ BRAIN_MCP_PRETTY_JSON: 'false' }), false);
    assert.equal(toolJson({ ok: true }, { BRAIN_MCP_PRETTY_JSON: 'false' }), '{"ok":true}');
  });

  it('caps oversized tool responses with a valid JSON truncation envelope', () => {
    const output = toolJson({ memories: [{ content: 'x'.repeat(2000) }] }, { BRAIN_MCP_MAX_RESPONSE_CHARS: '700' });
    const parsed = JSON.parse(output);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.max_response_chars, 700);
    assert.ok(parsed.original_char_count > 700);
    assert.ok(parsed.preview.length > 0);
    assert.ok(output.length <= 700);
  });

  it('allows the response cap to be disabled for operator-controlled exports', () => {
    const output = toolJson({ memories: [{ content: 'x'.repeat(2000) }] }, { BRAIN_MCP_MAX_RESPONSE_CHARS: '0' });
    assert.equal(JSON.parse(output).memories[0].content.length, 2000);
    assert.equal(maxToolJsonChars({ BRAIN_MCP_MAX_RESPONSE_CHARS: '0' }), 0);
  });

  it('does not parse malformed response cap strings as partial numbers', () => {
    assert.equal(maxToolJsonChars({ BRAIN_MCP_MAX_RESPONSE_CHARS: '700abc' }), 24000);
  });
});
