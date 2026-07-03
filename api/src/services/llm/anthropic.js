import fetchWithTimeout from '../fetch-with-timeout.js';
import { withRetry, resolveMaxTokens, LlmTruncationError, LlmHttpError, LlmResponseError } from './retry.js';

// Pure truncation detector — Anthropic signals a token-limit cutoff with
// stop_reason=max_tokens on the top-level response body.
export function isAnthropicTruncated(data) {
  return data?.stop_reason === 'max_tokens';
}

export class AnthropicProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'claude-sonnet-4-20250514';
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY required for Anthropic consolidation LLM');
  }

  async complete(prompt, options = {}) {
    return withRetry(async () => {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: resolveMaxTokens(options),
          system: 'You are a memory consolidation engine. Analyze memories and produce structured JSON output.',
          messages: [
            { role: 'user', content: prompt },
          ],
          temperature: options.temperature || 0.3,
        }),
      }, 120000);

      if (!response.ok) {
        const body = await response.text();
        throw new LlmHttpError(response.status, body, 'Anthropic');
      }

      const data = await response.json();

      if (isAnthropicTruncated(data)) {
        throw new LlmTruncationError('Anthropic response truncated at max_tokens (stop_reason=max_tokens)');
      }

      // content[0].text is absent on stop_reason other than end_turn (e.g. a
      // blocked or empty response) — fail descriptively instead of returning undefined.
      const text = data?.content?.[0]?.text;
      if (typeof text !== 'string') {
        throw new LlmResponseError(`Anthropic returned no text content (stop_reason=${data?.stop_reason ?? 'unknown'})`);
      }
      return text;
    });
  }
}
