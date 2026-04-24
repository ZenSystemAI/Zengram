import crypto from 'crypto';

// Single admin key. Callers are not identified per-agent; all writes are
// attributed to "claude-code" inside the memory route handler.
const ADMIN_KEY = process.env.BRAIN_API_KEY;

// Rate limiting: track failed auth attempts per IP
const failedAttempts = new Map();
const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record) return false;
  if (now - record.windowStart > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return record.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record || now - record.windowStart > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    record.count++;
  }
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const key = req.headers['x-api-key'] || req.query.key;
  if (!key) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Missing API key' });
  }

  if (safeEqual(key, ADMIN_KEY)) {
    return next();
  }

  recordFailure(ip);
  return res.status(401).json({ error: 'Invalid API key' });
}

// Periodic cleanup of expired failedAttempts entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of failedAttempts) {
    if (now - record.windowStart > WINDOW_MS) {
      failedAttempts.delete(ip);
    }
  }
}, 300_000).unref();
