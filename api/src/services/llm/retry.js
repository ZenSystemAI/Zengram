// Shared LLM provider infrastructure: typed errors, retryable-error
// classification, exponential backoff, and max-token resolution. Kept in one
// place so every provider (openai/anthropic/gemini/ollama) shares identical
// retry + truncation semantics instead of per-provider copies.

// Thrown when a provider returns a response that was cut off at the token limit.
// Callers use .truncated to distinguish "oversized batch" from a transient
// failure — retrying the same batch would just truncate again, so it is NOT
// retried by withRetry.
export class LlmTruncationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LlmTruncationError';
    this.code = 'llm_truncated';
    this.truncated = true;
    this.meta = meta;
  }
}

// Non-ok HTTP response from a provider. .status drives retry classification
// (429 + 5xx retry, other 4xx do not).
export class LlmHttpError extends Error {
  constructor(status, body, provider) {
    super(`${provider} API error: ${status} ${body}`);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

// Deterministic bad-shape response (blocked, empty, no candidates/content).
// retryable=false because retrying an identical request yields the same shape.
export class LlmResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmResponseError';
    this.retryable = false;
  }
}

export function isLlmTruncationError(err) {
  return err instanceof LlmTruncationError || err?.truncated === true;
}

// Retry only transient failures: 429/5xx HTTP responses and network-level
// errors (timeouts, resets — no HTTP status). Never retry truncation, other
// 4xx, or deterministic bad-shape responses.
export function isRetryableError(err) {
  if (!err) return false;
  if (err.truncated) return false;
  if (err.retryable === false) return false;
  if (typeof err.status === 'number') return err.status === 429 || err.status >= 500;
  return true;
}

const RETRY_BASE_MS = parseInt(process.env.LLM_RETRY_BASE_MS) || 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry by default with exponential backoff (baseMs * 2^attempt + jitter).
// sleep is injectable so tests can assert retry behaviour without real waits.
export async function withRetry(fn, {
  retries = 1,
  isRetryable = isRetryableError,
  baseMs = RETRY_BASE_MS,
  sleep = defaultSleep,
} = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
      await sleep(backoff);
      attempt++;
    }
  }
}

// A batch-of-50 consolidation response needs more than the old 4096-token
// default. LLM_MAX_TOKENS overrides; fallback is provider-specific for models
// (e.g. Gemini) whose thinking tokens share the output budget.
export function resolveMaxTokens(options = {}, fallback = 8192) {
  return options.max_tokens || Number(process.env.LLM_MAX_TOKENS) || fallback;
}
