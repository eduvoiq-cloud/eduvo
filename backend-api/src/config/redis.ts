/**
 * Redis client — optional but recommended for production.
 *
 * Set REDIS_URL in your environment (e.g. Railway Redis plugin) to enable:
 *   - Auth token caching (eliminates 2-3 DB queries per request)
 *   - Shared rate limit counters across multiple instances
 *
 * If REDIS_URL is not set the app runs without Redis — auth hits the DB on
 * every request and rate limits are in-process (not shared across instances).
 * This is fine for single-instance dev/staging but not for production scale.
 */

import Redis from 'ioredis';

let redis: Redis | null = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    // Reconnect with exponential back-off, capped at 30s
    retryStrategy: (times: number) => Math.min(times * 100, 30_000),
    // Short connect timeout so a broken Redis URL fails fast
    connectTimeout: 5_000,
    // Keep offline queue so commands issued before connection don't throw
    enableOfflineQueue: true,
  });

  redis.on('connect', () => console.log('[redis] Connected'));
  redis.on('error', (err: Error) => {
    console.error('[redis] Connection error (rate limits will use in-memory fallback):', err.message);
  });
} else {
  console.warn(
    '[redis] REDIS_URL not set — auth caching and shared rate limits are disabled. ' +
    'Set REDIS_URL in production for horizontal scaling support.'
  );
}

export default redis;
