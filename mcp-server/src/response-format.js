// Serialize tool results defensively. Local/Qwen-family tool parsers choke on
// pretty-printed JSON and on oversized payloads, so default to compact output
// and cap the response, replacing an over-limit body with a small truncation
// envelope that tells the caller how to narrow the request.

const DEFAULT_MAX_TOOL_JSON_CHARS = 24000;
const TRUNCATION_PREVIEW_CHARS = 1200;

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

export function shouldPrettyPrintToolJson(env = process.env) {
  return isTruthy(env.BRAIN_MCP_PRETTY_JSON);
}

export function maxToolJsonChars(env = process.env) {
  const raw = env.BRAIN_MCP_MAX_RESPONSE_CHARS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_TOOL_JSON_CHARS;
  const trimmed = String(raw).trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_MAX_TOOL_JSON_CHARS;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : 0;
}

function serialize(payload, env) {
  return JSON.stringify(payload, null, shouldPrettyPrintToolJson(env) ? 2 : 0);
}

function truncationPayload(serialized, maxChars, env) {
  const payload = {
    truncated: true,
    original_char_count: serialized.length,
    max_response_chars: maxChars,
    message: 'MCP tool response exceeded BRAIN_MCP_MAX_RESPONSE_CHARS. Retry with format="index" or "compact", a smaller limit, or narrower filters.',
    preview: '',
  };

  const withoutPreviewLength = serialize(payload, env).length;
  const previewBudget = Math.max(0, Math.min(TRUNCATION_PREVIEW_CHARS, maxChars - withoutPreviewLength - 16));
  payload.preview = serialized.slice(0, previewBudget);

  const wrapped = serialize(payload, env);
  if (wrapped.length <= maxChars || maxChars === 0) return payload;
  delete payload.preview;
  return payload;
}

export function toolJson(payload, env = process.env) {
  const serialized = serialize(payload, env);
  const maxChars = maxToolJsonChars(env);
  if (maxChars > 0 && serialized.length > maxChars) {
    return serialize(truncationPayload(serialized, maxChars, env), env);
  }
  return serialized;
}
