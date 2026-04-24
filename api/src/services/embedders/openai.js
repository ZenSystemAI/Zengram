import OpenAI from 'openai';

export class OpenAIEmbedder {
  constructor() {
    this.model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    this.dimensions = parseInt(process.env.OPENAI_EMBEDDING_DIMS) || 768;
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async embed(text) {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    if (!Array.isArray(response?.data?.[0]?.embedding)) {
      throw new Error(`OpenAI embed returned unexpected shape: ${JSON.stringify(response).slice(0, 200)}`);
    }
    return response.data[0].embedding;
  }

  getDimensions() {
    return this.dimensions;
  }
}
