import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingDimensions } from '../src/services/embedders/dimensions.js';

async function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const value = values[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('embedding dimensions', () => {
  it('returns the provider fallback when the env var is unset', async () => {
    await withEnv({
      OPENAI_EMBEDDING_DIMS: null,
      GEMINI_EMBEDDING_DIMS: null,
    }, async () => {
      assert.equal(embeddingDimensions('OPENAI_EMBEDDING_DIMS', 768), 768);
      assert.equal(embeddingDimensions('GEMINI_EMBEDDING_DIMS', 3072), 3072);
    });
  });

  it('uses an explicit positive integer dimension', async () => {
    await withEnv({ TEST_EMBEDDING_DIMS: '1536' }, async () => {
      assert.equal(embeddingDimensions('TEST_EMBEDDING_DIMS', 768), 1536);
    });
  });

  it('rejects malformed dimensions instead of silently changing vector shape', async () => {
    await withEnv({ TEST_EMBEDDING_DIMS: '768px' }, async () => {
      assert.throws(
        () => embeddingDimensions('TEST_EMBEDDING_DIMS', 768),
        /TEST_EMBEDDING_DIMS must be a positive integer/
      );
    });
  });

  it('rejects zero and negative dimensions', async () => {
    await withEnv({ TEST_EMBEDDING_DIMS: '0' }, async () => {
      assert.throws(() => embeddingDimensions('TEST_EMBEDDING_DIMS', 768), /positive integer/);
    });
    await withEnv({ TEST_EMBEDDING_DIMS: '-5' }, async () => {
      assert.throws(() => embeddingDimensions('TEST_EMBEDDING_DIMS', 768), /positive integer/);
    });
  });
});
