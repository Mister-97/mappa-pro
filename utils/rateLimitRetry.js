'use strict';

/**
 * Wraps an async function with retry logic for HTTP 429 (Too Many Requests).
 *
 * - Respects Retry-After response header when present (seconds or HTTP-date)
 * - Falls back to exponential backoff: baseDelayMs * 2^attempt
 * - Passes through all non-429 errors immediately (no silent swallowing)
 *
 * Usage:
 *   const { withRetry } = require('../utils/rateLimitRetry');
 *   const data = await withRetry(() => fanvueApi.getInsightsEarnings(account, opts));
 *
 * @param {Function} fn          – zero-arg async function to call
 * @param {object}   [opts]
 * @param {number}   [opts.maxRetries=3]     – max retry attempts after the first failure
 * @param {number}   [opts.baseDelayMs=1000] – base backoff delay in ms
 * @returns {Promise<*>}
 */
async function withRetry(fn, { maxRetries = 3, baseDelayMs = 1000 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;

      if (status !== 429 || attempt >= maxRetries) {
        throw err;
      }

      const retryAfterHeader = err.response?.headers?.['retry-after'];
      let waitMs;

      if (retryAfterHeader) {
        // Retry-After can be seconds (number) or an HTTP-date string
        const parsed = Number(retryAfterHeader);
        waitMs = isNaN(parsed)
          ? Math.max(0, new Date(retryAfterHeader) - Date.now())
          : parsed * 1000;
      } else {
        // Exponential backoff with jitter: base * 2^attempt + random 0-500ms
        waitMs = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      }

      console.warn(`[RateLimit] 429 hit (attempt ${attempt + 1}/${maxRetries}), waiting ${Math.round(waitMs)}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      attempt++;
    }
  }
}

module.exports = { withRetry };
