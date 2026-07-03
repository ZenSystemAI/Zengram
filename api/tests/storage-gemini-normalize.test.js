import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { l2Normalize } from '../src/services/embedders/gemini.js';

function norm(vec) {
  return Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
}

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    const out = l2Normalize([3, 4]);
    assert.ok(Math.abs(norm(out) - 1) < 1e-12);
    assert.ok(Math.abs(out[0] - 0.6) < 1e-12);
    assert.ok(Math.abs(out[1] - 0.8) < 1e-12);
  });

  it('leaves an already-unit vector effectively unchanged', () => {
    const out = l2Normalize([1, 0, 0]);
    assert.ok(Math.abs(norm(out) - 1) < 1e-12);
    assert.deepEqual(out, [1, 0, 0]);
  });

  it('preserves direction (sign) while renormalizing', () => {
    const out = l2Normalize([-3, 0, 4]);
    assert.ok(Math.abs(norm(out) - 1) < 1e-12);
    assert.ok(out[0] < 0);
    assert.ok(out[2] > 0);
  });

  it('returns the zero vector unchanged instead of dividing by zero', () => {
    const out = l2Normalize([0, 0, 0]);
    assert.deepEqual(out, [0, 0, 0]);
  });
});
