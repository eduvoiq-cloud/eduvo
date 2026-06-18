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
    // Don't block app startup if Redis is temporarily unreachable
    lazyConnect: true,
    // Short connect timeout so a broken Redis URL fails fast
    connectTimeout: 5_000,
    // Emit errors to console rather than crashing the process
    enableOfflineQueue: false,
  });

  redis.on('connect', () => console.log('[redis] Connected'));
  redis.on('error', (err: Error) => {
    console.error('[redis] Connection error (rate limits will use in-memory fallback):', err.message);
  });

  // Connect eagerly so the first request doesn't pay the connection cost
  redis.connect().catch((err: Error) => {
    console.error('[redis] Failed to connect at startup:', err.message);
  });
} else {
  console.warn(
    '[redis] REDIS_URL not set — auth caching and shared rate limits are disabled. ' +
    'Set REDIS_URL in production for horizontal scaling support.'
  );
}

export default redis;
