const TASK_TYPE_MAP = {
  store: 'RETRIEVAL_DOCUMENT',
  search: 'RETRIEVAL_QUERY',
};

export class GeminiEmbedder {
  constructor() {
    this.model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview';
    this.dimensions = parseInt(process.env.GEMINI_EMBEDDING_DIMS) || 3072;
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini embed error: ${response.status} ${errBody}`);
    }

    const data = await response.json();
    return data.embedding.values;
  }

  getDimensions() {
    return this.dimensions;
  }
}
