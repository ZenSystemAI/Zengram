import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITY_TYPE_VALUES, normalizeEntityType } from '../src/services/entity-utils.js';

describe('normalizeEntityType', () => {
  it('returns the canonical value for a valid type', () => {
    assert.equal(normalizeEntityType('client'), 'client');
  });

  it('lowercases and trims before matching', () => {
    assert.equal(normalizeEntityType('  Technology '), 'technology');
  });

  it('returns undefined for an unknown type', () => {
    assert.equal(normalizeEntityType('spaceship'), undefined);
  });

  it('returns undefined for non-string input', () => {
    assert.equal(normalizeEntityType(42), undefined);
    assert.equal(normalizeEntityType(null), undefined);
    assert.equal(normalizeEntityType(undefined), undefined);
  });

  it('accepts every canonical value', () => {
    for (const type of ENTITY_TYPE_VALUES) {
      assert.equal(normalizeEntityType(type), type);
    }
  });
});
