import fetchWithTimeout from '../fetch-with-timeout.js';

export class GeminiProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'gemini-2.5-flash';
    this.apiKey = process.env.GEMINI_API_KEY;
    if (!this.apiKey) throw new Error('GEMINI_API_KEY required for Gemini consolidation LLM');
  }

  async complete(prompt, options = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `You are a memory consolidation engine. Analyze memories and produce structured JSON output. Return ONLY valid JSON, no markdown fences.\n\n${prompt}` }],
          },
        ],
        generationConfig: {
          temperature: options.temperature || 0.3,
          maxOutputTokens: options.max_tokens || 4096,
          responseMimeType: 'application/json',
        },
      }),
    }, 120000);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${body}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }
}
