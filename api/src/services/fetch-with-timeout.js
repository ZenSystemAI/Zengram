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
      throw new Error(`Request timed out after ${timeoutMs}ms: ${options.method || 'GET'} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
