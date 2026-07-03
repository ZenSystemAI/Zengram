// Credential scrubbing — redacts secrets before storing memories

import crypto from 'crypto';

// Short deterministic content fingerprint used as the dedup key across the
// write pipeline. First 16 hex chars of SHA-256; long enough to make
// collisions vanishingly unlikely at the corpus sizes Zengram handles.
export function contentHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const PATTERNS = [
  // API keys and tokens
  { regex: /(?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*['"]?[\w\-./]{20,}['"]?/gi, replace: '[CREDENTIAL_REDACTED]' },
  // JWT tokens
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: '[JWT_REDACTED]' },
  // Base64 long strings that look like secrets
  { regex: /(?:key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9+/]{40,}={0,2}['"]?/gi, replace: '[SECRET_REDACTED]' },
  // Email passwords
  { regex: /(?:smtp|email|mail).*?(?:pass|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi, replace: '[EMAIL_CRED_REDACTED]' },
  // SSH private keys
  { regex: /-----BEGIN [\w\s]+ PRIVATE KEY-----[\s\S]*?-----END [\w\s]+ PRIVATE KEY-----/g, replace: '[PRIVATE_KEY_REDACTED]' },
  // AWS access key IDs
  { regex: /AKIA[0-9A-Z]{16}/g, replace: '[AWS_KEY_REDACTED]' },
  // Connection strings (postgres, mongodb, redis, mysql)
  { regex: /(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis|mysql|amqp):\/\/[^\s'"]+/gi, replace: '[CONNECTION_STRING_REDACTED]' },
  // OpenAI / Anthropic API keys
  { regex: /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, replace: '[API_KEY_REDACTED]' },
  // Stripe keys — secret/restricted/publishable, live + test variants
  { regex: /\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: '[STRIPE_KEY_REDACTED]' },
  // Google API keys (AIza + 35 chars). No trailing \b — the fixed length bounds it.
  { regex: /AIza[0-9A-Za-z_-]{35}/g, replace: '[GOOGLE_API_KEY_REDACTED]' },
  // Slack tokens (bot/user/app/refresh/legacy: xoxb/xoxa/xoxp/xoxr/xoxs)
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[SLACK_TOKEN_REDACTED]' },
  // GitHub tokens (personal/oauth/user/server/refresh: ghp/gho/ghu/ghs/ghr).
  // Underscore + 36+ chars keeps prose like "ghost"/"ghoul" from matching.
  { regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replace: '[GITHUB_TOKEN_REDACTED]' },
];

export function scrubCredentials(text) {
  if (!text || typeof text !== 'string') return text;
  let scrubbed = text;
  for (const { regex, replace } of PATTERNS) {
    scrubbed = scrubbed.replace(regex, replace);
  }
  return scrubbed;
}

// Recursively scrub all string values in an object
export function scrubObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return scrubCredentials(obj);
  if (Array.isArray(obj)) return obj.map(item => scrubObject(item));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = scrubObject(value);
    }
    return result;
  }
  return obj; // numbers, booleans, etc.
}
