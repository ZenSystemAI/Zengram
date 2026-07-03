import OpenAI from 'openai';
import { withRetry, resolveMaxTokens, LlmTruncationError, LlmResponseError } from './retry.js';

// Pure truncation detector — extracted so it is unit-testable against fake
// response objects. OpenAI signals a token-limit cutoff with finish_reason=length.
export function isOpenAiTruncated(response) {
  return response?.choices?.[0]?.finish_reason === 'length';
}

export class OpenAIProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'gpt-4o-mini';
    // maxRetries: 0 — withRetry below is the single retry authority; the SDK's
    // default of 2 internal retries would stack multiplicatively with it
    // (up to 6 HTTP attempts under a sustained 429/5xx).
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  }

  async complete(prompt, options = {}) {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a memory consolidation engine. Analyze memories and produce structured JSON output.' },
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature || 0.3,
        max_tokens: resolveMaxTokens(options),
        response_format: { type: 'json_object' },
      });

      if (isOpenAiTruncated(response)) {
        throw new LlmTruncationError('OpenAI response truncated at max_tokens (finish_reason=length)');
      }

      const content = response?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LlmResponseError('OpenAI returned no message content');
      }
      return content;
    });
  }
}
