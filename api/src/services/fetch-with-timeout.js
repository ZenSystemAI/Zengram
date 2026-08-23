/**
 * Fetch wrapper with AbortController-based timeout.
 * @param {string|URL} url
 * @param {RequestInit} [options={}]
 * @param {number} [timeoutMs=30000] — milliseconds before aborting
 * @returns {Promise<Response>}
 */
export default async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      // Do not interpolate `url` — callers (Gemini) historically put API keys
      // in the query string, and the timeout Error is logged upstream.
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
