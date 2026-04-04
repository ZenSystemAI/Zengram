import crypto from 'crypto';

const ADMIN_KEY = process.env.BRAIN_API_KEY;

// Build agent registry from env vars: AGENT_KEY_<name>=<key>
// e.g. AGENT_KEY_claude_code=abc123 → { key: 'abc123', agent: 'claude-code' }
const agentRegistry = new Map(); // key → agent name

function loadAgentKeys() {
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith('AGENT_KEY_') && envVal) {
      // AGENT_KEY_claude_code → claude-code
      const agentName = envKey.slice('AGENT_KEY_'.length).replace(/_/g, '-').toLowerCase();
      agentRegistry.set(envVal, agentName);
    }
  }
  if (agentRegistry.size > 0) {
    console.log(`[auth] Loaded ${agentRegistry.size} agent key(s): ${[...agentRegistry.values()].join(', ')}`);
  }
}

loadAgentKeys();

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

  // Check agent-specific keys first (binds identity)
  const agentName = agentRegistry.get(key);
  if (agentName) {
    req.authenticatedAgent = agentName;
    return next();
  }

  // Fall back to admin key (no agent binding — full access)
  if (safeEqual(key, ADMIN_KEY)) {
    req.authenticatedAgent = null; // admin — no agent identity enforced
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
