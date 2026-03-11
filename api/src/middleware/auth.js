import crypto from 'crypto';

const API_KEY = process.env.BRAIN_API_KEY;

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

export function authMiddleware(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const key = req.headers['x-api-key'];
  if (!key || !API_KEY || key.length !== API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(API_KEY))) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}
