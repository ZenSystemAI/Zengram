import fetchWithTimeout from '../fetch-with-timeout.js';

export class OllamaEmbedder {
  constructor() {
    this.model = process.env.OLLAMA_MODEL || 'nomic-embed-text';
    this.baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.dimensions = null;
  }

  // Auto-detect dimensions by running a test embedding
  async init() {
    const test = await this.embed('dimension detection');
    this.dimensions = test.length;
  }

  async embed(text) {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    }, 120000);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed error: ${response.status} ${body}`);
    }

    const data = await response.json();
    // Ollama returns { embeddings: [[...]] } for single input
    return data.embeddings[0];
  }

  getDimensions() {
    return this.dimensions;
  }
}
