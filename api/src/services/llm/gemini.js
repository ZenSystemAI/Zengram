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
          maxOutputTokens: options.max_tokens || 65536,
          responseMimeType: 'application/json',
          // Gemini 2.5 Flash thinking tokens count against maxOutputTokens.
          // Cap thinking to preserve budget for the actual JSON response.
          thinkingConfig: { thinkingBudget: options.thinking_budget || 8192 },
        },
      }),
    }, 120000);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${body}`);
    }

    const data = await response.json();
    const candidate = data.candidates[0];

    // Check for truncation — Gemini returns MAX_TOKENS when thinking + output exceeds budget
    if (candidate.finishReason === 'MAX_TOKENS') {
      const meta = data.usageMetadata || {};
      console.warn(`[gemini] Response truncated: thinking=${meta.thoughtsTokenCount || '?'}, output=${meta.candidatesTokenCount || '?'}, limit=${options.max_tokens || 65536}`);
    }

    // Take the last non-thinking part (thinking parts have thought:true)
    const parts = candidate.content.parts;
    const outputPart = parts.findLast(p => !p.thought) || parts[parts.length - 1];
    return outputPart.text;
  }
}
