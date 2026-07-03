import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVectorVersion,
  supportsIterativeScan,
  clampEfSearch,
  halfvecMode,
  vectorDistanceExpr,
  dimsGuardShouldExit,
} from '../src/services/pgvector.js';

describe('parseVectorVersion', () => {
  it('parses a full semver extversion', () => {
    assert.deepEqual(parseVectorVersion('0.8.0'), { major: 0, minor: 8 });
    assert.deepEqual(parseVectorVersion('0.7.4'), { major: 0, minor: 7 });
    assert.deepEqual(parseVectorVersion('1.12.3'), { major: 1, minor: 12 });
  });

  it('parses a two-part version', () => {
    assert.deepEqual(parseVectorVersion('0.8'), { major: 0, minor: 8 });
  });

  it('returns null on unparseable input', () => {
    assert.equal(parseVectorVersion(undefined), null);
    assert.equal(parseVectorVersion(null), null);
    assert.equal(parseVectorVersion(''), null);
    assert.equal(parseVectorVersion('vX.Y'), null);
    assert.equal(parseVectorVersion(0.8), null);
  });
});

describe('supportsIterativeScan', () => {
  it('is true for 0.8.0 and above', () => {
    assert.equal(supportsIterativeScan({ major: 0, minor: 8 }), true);
    assert.equal(supportsIterativeScan({ major: 0, minor: 9 }), true);
    assert.equal(supportsIterativeScan({ major: 1, minor: 0 }), true);
  });

  it('is false below 0.8 and for null', () => {
    assert.equal(supportsIterativeScan({ major: 0, minor: 7 }), false);
    assert.equal(supportsIterativeScan({ major: 0, minor: 0 }), false);
    assert.equal(supportsIterativeScan(null), false);
  });
});

describe('clampEfSearch', () => {
  it('floors at 40 for small limits', () => {
    assert.equal(clampEfSearch(10), 40);
    assert.equal(clampEfSearch(1), 40);
    assert.equal(clampEfSearch(20), 40);
  });

  it('uses limit*2 in the mid band', () => {
    assert.equal(clampEfSearch(50), 100);
    assert.equal(clampEfSearch(100), 200);
  });

  it('caps at 400 for large limits', () => {
    assert.equal(clampEfSearch(300), 400);
    assert.equal(clampEfSearch(10000), 400);
  });

  it('defaults to 40 for non-finite input', () => {
    assert.equal(clampEfSearch(undefined), 40);
    assert.equal(clampEfSearch(NaN), 40);
  });
});

describe('halfvecMode', () => {
  it('stays vector at or below the 2000-dim cap', () => {
    assert.equal(halfvecMode(768), 'vector');
    assert.equal(halfvecMode(1536), 'vector');
    assert.equal(halfvecMode(2000), 'vector');
  });

  it('switches to halfvec above the cap', () => {
    assert.equal(halfvecMode(2001), 'halfvec');
    assert.equal(halfvecMode(3072), 'halfvec');
  });
});

describe('vectorDistanceExpr', () => {
  it('emits a plain vector cast in vector mode', () => {
    assert.equal(vectorDistanceExpr('vector', 1536), 'vector <=> $1::vector');
  });

  it('casts both operands to halfvec in halfvec mode', () => {
    assert.equal(
      vectorDistanceExpr('halfvec', 3072),
      '(vector::halfvec(3072)) <=> $1::halfvec(3072)'
    );
  });

  it('honors a custom param placeholder', () => {
    assert.equal(vectorDistanceExpr('vector', 1536, '$3'), 'vector <=> $3::vector');
  });
});

describe('dimsGuardShouldExit', () => {
  it('exits when the declared column dims differ from the provider dims', () => {
    assert.equal(dimsGuardShouldExit(1536, 3072), true);
    assert.equal(dimsGuardShouldExit(3072, 1536), true);
  });

  it('does not exit when they match', () => {
    assert.equal(dimsGuardShouldExit(1536, 1536), false);
  });

  it('does not exit when the column dims are unknown/unspecified', () => {
    assert.equal(dimsGuardShouldExit(-1, 1536), false);
    assert.equal(dimsGuardShouldExit(null, 1536), false);
    assert.equal(dimsGuardShouldExit(undefined, 1536), false);
  });
});
