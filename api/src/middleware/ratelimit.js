// Per-key request rate limiting for authenticated endpoints

const buckets = new Map(); // key -> { writes: { count, windowStart }, reads: { ... }, consolidation: { ... } }

const LIMITS = {
  write: { max: parseInt(process.env.RATE_LIMIT_WRITES) || 60, windowMs: 60_000 },
  read: { max: parseInt(process.env.RATE_LIMIT_READS) || 120, windowMs: 60_000 },
  consolidation: { max: 1, windowMs: 3_600_000 }, // 1 per hour
};

function getBucket(apiKey, type) {
  const now = Date.now();
  if (!buckets.has(apiKey)) buckets.set(apiKey, {});
  const keyBuckets = buckets.get(apiKey);

  if (!keyBuckets[type] || now - keyBuckets[type].windowStart > LIMITS[type].windowMs) {
    keyBuckets[type] = { count: 0, windowStart: now };
  }

  return keyBuckets[type];
}

function checkLimit(apiKey, type) {
  const bucket = getBucket(apiKey, type);
  if (bucket.count >= LIMITS[type].max) {
    const retryAfter = Math.ceil((bucket.windowStart + LIMITS[type].windowMs - Date.now()) / 1000);
    return { limited: true, retryAfter };
  }
  bucket.count++;
  return { limited: false };
}

// Classify route + method into a rate limit type
function classifyRequest(method, path) {
  if (path.startsWith('/consolidate') && method === 'POST') return 'consolidation';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return 'write';
  return 'read';
}

export function rateLimitMiddleware(req, res, next) {
  const apiKey = req.rateLimitKey || req.headers['x-api-key'] || req.headers.authorization || req.query?.key || 'unknown';
  const type = classifyRequest(req.method, req.path);
  const { limited, retryAfter } = checkLimit(apiKey, type);

  if (limited) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Rate limit exceeded for ${type} requests. Try again in ${retryAfter}s.`,
      limit: LIMITS[type].max,
      window_seconds: LIMITS[type].windowMs / 1000,
    });
  }

  next();
}

// Periodic cleanup of stale buckets (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, keyBuckets] of buckets) {
    let allExpired = true;
    for (const [type, bucket] of Object.entries(keyBuckets)) {
      if (now - bucket.windowStart <= LIMITS[type]?.windowMs) {
        allExpired = false;
      }
    }
    if (allExpired) buckets.delete(key);
  }
}, 600_000).unref();
