import fetchWithTimeout from '../fetch-with-timeout.js';

export class AnthropicProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'claude-sonnet-4-20250514';
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY required for Anthropic consolidation LLM');
  }

  async complete(prompt, options = {}) {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.max_tokens || 4096,
        system: 'You are a memory consolidation engine. Analyze memories and produce structured JSON output.',
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature || 0.3,
      }),
    }, 120000);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${body}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }
}
