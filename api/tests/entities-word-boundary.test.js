import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, loadAliasCache } from '../src/services/entities.js';

// KNOWN_SYSTEMS now matches on word boundaries (like KNOWN_TECH). Previously it
// used a raw lowerText.includes(), which fired on substrings inside longer,
// unrelated tokens. These tests lock in the boundary behavior.

describe('extractEntities — KNOWN_SYSTEMS word-boundary matching', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('still matches a known system as a whole word', () => {
    const entities = extractEntities('Deployed a Globex update overnight', 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Globex'));
  });

  it('does not fire on a known-system name embedded in a longer token', () => {
    // "globex" is a substring of "globexpansion" — includes() would match, the
    // word-boundary regex must not.
    const entities = extractEntities('Our globexpansion roadmap for Q3', 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('Globex'), 'must not extract Globex from "globexpansion"');
  });

  it('does not fire on a multi-word system embedded without boundaries', () => {
    // "search console" should not match inside "searchconsolelog" style tokens.
    const entities = extractEntities('the researchconsoleoutput was noisy', 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('Search Console'));
  });

  it('matches a multi-word system when it appears as whole words', () => {
    const entities = extractEntities('Checked the Search Console coverage report', 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Search Console'));
  });
});
