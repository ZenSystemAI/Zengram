import fetchWithTimeout from '../fetch-with-timeout.js';
import { embeddingDimensions } from './dimensions.js';

const TASK_TYPE_MAP = {
  store: 'RETRIEVAL_DOCUMENT',
  search: 'RETRIEVAL_QUERY',
};

// The model's native output dimensionality. Matryoshka truncation to a smaller
// dimensionality is documented and supported, but truncated vectors are NOT
// unit-normalized — cosine distance needs them renormalized (see embed()).
const GEMINI_NATIVE_DIMS = 3072;

// L2 (unit) normalization. Returns the vector unchanged if its norm is 0 (all
// zeros) to avoid dividing by zero. Pure — exported for unit tests.
export function l2Normalize(vector) {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  return vector.map(v => v / norm);
}

export class GeminiEmbedder {
  constructor() {
    this.model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview';
    this.dimensions = embeddingDimensions('GEMINI_EMBEDDING_DIMS', 1536);
    this.apiKey = process.env.GEMINI_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
    }
  }

  async embed(text, purpose) {
    const url = `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`;

    const body = {
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      outputDimensionality: this.dimensions,
    };

    // Use task-specific embedding when purpose is provided
    const taskType = TASK_TYPE_MAP[purpose];
    if (taskType) {
      body.taskType = taskType;
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60000);

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini embed error: ${response.status} ${errBody}`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.embedding?.values)) {
      throw new Error(`Gemini embed returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
    }
    // Truncated (< native) Matryoshka vectors are not unit-normalized — renormalize
    // so cosine distance stays meaningful. Full-dim vectors are already normalized.
    if (this.dimensions < GEMINI_NATIVE_DIMS) {
      return l2Normalize(data.embedding.values);
    }
    return data.embedding.values;
  }

  getDimensions() {
    return this.dimensions;
  }
}
