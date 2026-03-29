import fetchWithTimeout from '../fetch-with-timeout.js';

export class OllamaProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'llama3.2';
    this.baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  }

  async complete(prompt, options = {}) {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory consolidation engine. Analyze memories and produce structured JSON output. Always respond with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: {
          temperature: options.temperature || 0.3,
          num_predict: options.max_tokens || 4096,
        },
        format: 'json',
      }),
    }, 300000);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${body}`);
    }

    const data = await response.json();
    return data.message.content;
  }
}
