import OpenAI from 'openai';
import { embeddingDimensions } from './dimensions.js';

// OpenAI-compatible embedder. Talks to the OpenAI API by default, OR to any
// OpenAI-compatible server (vLLM, Infinity, text-embeddings-inference,
// llama.cpp --embeddings, LiteLLM…) when OPENAI_BASE_URL is set — which is how
// modern open-weights encoders (Qwen3-Embedding, e5, gte-Qwen, etc.) are
// self-hosted.
//
// Matryoshka truncation: the `dimensions` request param is sent ONLY when
// OPENAI_EMBEDDING_DIMS is explicitly configured. Local servers commonly reject
// an unexpected `dimensions` field, so by default we omit it and adopt the
// model's native dimensionality (probed at init()).
export class OpenAIEmbedder {
  constructor() {
    this.model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    // Local OpenAI-compatible servers often need no real key; send a placeholder
    // so the SDK doesn't throw when OPENAI_API_KEY is unset but a baseURL is.
    const apiKey = process.env.OPENAI_API_KEY || (baseURL ? 'sk-local' : undefined);
    this.client = new OpenAI({ apiKey, baseURL });

    const rawDims = process.env.OPENAI_EMBEDDING_DIMS;
    this.explicitDims = rawDims != null && rawDims !== '';
    this.dimensions = this.explicitDims ? embeddingDimensions('OPENAI_EMBEDDING_DIMS', 768) : null;
  }

  // Probe native dimensions when not explicitly configured (mirrors Ollama).
  async init() {
    if (this.dimensions == null) {
      const test = await this.embed('dimension detection');
      this.dimensions = test.length;
    }
  }

  async embed(text) {
    const params = { model: this.model, input: text };
    // Only request a specific dimensionality when explicitly configured.
    if (this.explicitDims && this.dimensions) params.dimensions = this.dimensions;

    const response = await this.client.embeddings.create(params);
    if (!Array.isArray(response?.data?.[0]?.embedding)) {
      throw new Error(`OpenAI embed returned unexpected shape: ${JSON.stringify(response).slice(0, 200)}`);
    }
    return response.data[0].embedding;
  }

  getDimensions() {
    return this.dimensions;
  }
}
