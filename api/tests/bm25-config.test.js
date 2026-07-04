import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bm25TsConfig, isManagedTsConfig, DEFAULT_TSCONFIG, MANAGED_TSCONFIG } from '../src/services/bm25-config.js';

const orig = process.env.BM25_TSCONFIG;
afterEach(() => {
  if (orig === undefined) delete process.env.BM25_TSCONFIG;
  else process.env.BM25_TSCONFIG = orig;
});

describe('bm25-config', () => {
  it('defaults to the english config (unchanged behavior, unmanaged)', () => {
    delete process.env.BM25_TSCONFIG;
    assert.equal(bm25TsConfig(), DEFAULT_TSCONFIG);
    assert.equal(DEFAULT_TSCONFIG, 'english');
    assert.equal(isManagedTsConfig(), false);
  });

  it('marks the managed multilingual config as managed', () => {
    process.env.BM25_TSCONFIG = MANAGED_TSCONFIG;
    assert.equal(bm25TsConfig(), MANAGED_TSCONFIG);
    assert.equal(MANAGED_TSCONFIG, 'zengram_multi');
    assert.equal(isManagedTsConfig(), true);
  });

  it('honors an arbitrary valid override and marks it unmanaged', () => {
    process.env.BM25_TSCONFIG = 'french';
    assert.equal(bm25TsConfig(), 'french');
    assert.equal(isManagedTsConfig('french'), false);
  });

  it('rejects non-identifier values (SQL-injection guard)', () => {
    for (const bad of ["simple; DROP TABLE memory_search", "fr en", "'english'", '1cfg', 'a-b']) {
      process.env.BM25_TSCONFIG = bad;
      assert.throws(() => bm25TsConfig(), /Invalid BM25_TSCONFIG/);
    }
  });
});
