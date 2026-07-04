import OpenAI from 'openai';
import { withRetry, resolveMaxTokens, LlmTruncationError, LlmResponseError } from './retry.js';

// Pure truncation detector — extracted so it is unit-testable against fake
// response objects. OpenAI signals a token-limit cutoff with finish_reason=length.
export function isOpenAiTruncated(response) {
  return response?.choices?.[0]?.finish_reason === 'length';
}

// Optional template kwargs for self-hosted reasoning models, e.g.
// LLM_CHAT_TEMPLATE_KWARGS='{"enable_thinking": false}' disables Qwen 3.x
// thinking mode at the chat-template level (vLLM and llama.cpp both accept
// chat_template_kwargs in the request body). Leave unset when pointing at
// the real OpenAI API — it rejects unknown request arguments.
export function parseChatTemplateKwargs() {
  const raw = process.env.LLM_CHAT_TEMPLATE_KWARGS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to the warning below
  }
  console.warn('[llm/openai] Ignoring LLM_CHAT_TEMPLATE_KWARGS: must be a JSON object');
  return null;
}

export class OpenAIProvider {
  constructor() {
    this.model = process.env.CONSOLIDATION_MODEL || 'gpt-4o-mini';
    this.chatTemplateKwargs = parseChatTemplateKwargs();
    // maxRetries: 0 — withRetry below is the single retry authority; the SDK's
    // default of 2 internal retries would stack multiplicatively with it
    // (up to 6 HTTP attempts under a sustained 429/5xx).
    // baseURL lets self-hosted OpenAI-compatible endpoints (vLLM, llama.cpp)
    // stand in for the real API; sk-no-auth is a placeholder those accept.
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'sk-no-auth',
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      maxRetries: 0,
    });
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
        ...(this.chatTemplateKwargs ? { chat_template_kwargs: this.chatTemplateKwargs } : {}),
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
