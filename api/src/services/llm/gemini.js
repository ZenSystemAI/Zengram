import fetchWithTimeout from '../fetch-with-timeout.js';
import { withRetry, resolveMaxTokens, LlmTruncationError, LlmHttpError, LlmResponseError } from './retry.js';

// Pure truncation detector — Gemini returns finishReason=MAX_TOKENS when
// thinking + output exceeds maxOutputTokens.
export function isGeminiTruncated(data) {
  return data?.candidates?.[0]?.finishReason === 'MAX_TOKENS';
}

export class GeminiProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'gemini-2.5-flash';
    this.apiKey = process.env.GEMINI_API_KEY;
    if (!this.apiKey) throw new Error('GEMINI_API_KEY required for Gemini consolidation LLM');
  }

  async complete(prompt, options = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    return withRetry(async () => {
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
            // Gemini's thinking tokens count against maxOutputTokens, so keep a
            // generous default here rather than the shared 8192 fallback.
            maxOutputTokens: resolveMaxTokens(options, 65536),
            responseMimeType: 'application/json',
            // Gemini 2.5 Flash thinking tokens count against maxOutputTokens.
            // Cap thinking to preserve budget for the actual JSON response.
            thinkingConfig: { thinkingBudget: options.thinking_budget || 8192 },
          },
        }),
      }, 120000);

      if (!response.ok) {
        const body = await response.text();
        throw new LlmHttpError(response.status, body, 'Gemini');
      }

      const data = await response.json();

      // No candidate at all — blocked prompt or empty generation.
      const candidate = data?.candidates?.[0];
      if (!candidate) {
        const reason = data?.promptFeedback?.blockReason || 'no candidates returned';
        throw new LlmResponseError(`Gemini returned no candidates (${reason})`);
      }

      // Truncated at the token limit — retrying the same request truncates again.
      if (candidate.finishReason === 'MAX_TOKENS') {
        const meta = data.usageMetadata || {};
        throw new LlmTruncationError('Gemini response truncated at max_tokens', {
          thinking: meta.thoughtsTokenCount,
          output: meta.candidatesTokenCount,
        });
      }

      const parts = candidate.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new LlmResponseError(`Gemini candidate has no content parts (finishReason=${candidate.finishReason ?? 'unknown'})`);
      }

      // Take the last non-thinking part (thinking parts have thought:true)
      const outputPart = parts.findLast(p => !p.thought) || parts[parts.length - 1];
      if (typeof outputPart?.text !== 'string') {
        throw new LlmResponseError('Gemini output part has no text');
      }
      return outputPart.text;
    });
  }
}
