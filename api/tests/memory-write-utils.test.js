import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDedupExtraFilter, normalizeImportRecord, normalizeMemoryRecord } from '../src/services/memory-write-utils.js';

describe('buildDedupExtraFilter', () => {
  test('includes active + tenant scope + type', () => {
    assert.deepEqual(buildDedupExtraFilter('acme', 'event'), {
      active: true,
      client_id: 'acme',
      type: 'event',
    });
  });

  test('defaults client_id to global', () => {
    assert.deepEqual(buildDedupExtraFilter(undefined, 'fact'), {
      active: true,
      client_id: 'global',
      type: 'fact',
    });
  });
});


describe('normalizeMemoryRecord', () => {
  test('requires type/source_agent when no defaults are supplied', () => {
    const { error } = normalizeMemoryRecord({ content: 'hello' });
    assert.match(error, /type is required/);
  });

  test('normalizes and hashes valid store payloads', () => {
    const { normalized, contentHash, error } = normalizeMemoryRecord({
      type: 'event',
      content: 'api_key=sk_live_abc123def456ghi789',
      source_agent: 'agent_1',
    });

    assert.equal(error, undefined);
    assert.equal(normalized.client_id, 'global');
    assert.equal(typeof contentHash, 'string');
    assert.equal(contentHash.length, 16);
    assert.match(normalized.content, /\[CREDENTIAL_REDACTED\]/);
  });
});

describe('normalizeImportRecord', () => {
  test('normalizes defaults and validates record', () => {
    const { normalized, error } = normalizeImportRecord({
      content: 'Deployment completed',
      source_agent: 'import_agent',
    });

    assert.equal(error, undefined);
    assert.equal(normalized.type, 'event');
    assert.equal(normalized.client_id, 'global');
    assert.equal(normalized.importance, 'medium');
    assert.equal(normalized.category, 'episodic');
  });

  test('scrubs credentials from imported content', () => {
    const { normalized, error } = normalizeImportRecord({
      type: 'event',
      source_agent: 'import_agent',
      content: 'token=sk_live_abc123def456ghi789',
    });

    assert.equal(error, undefined);
    assert.match(normalized.content, /\[CREDENTIAL_REDACTED\]/);
  });

  test('rejects invalid source_agent', () => {
    const { error } = normalizeImportRecord({
      type: 'event',
      source_agent: 'bad agent with spaces',
      content: 'hello',
    });

    assert.match(error, /source_agent/);
  });
});
