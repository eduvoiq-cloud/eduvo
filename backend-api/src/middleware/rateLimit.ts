import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request } from 'express';
import type { SendCommandFn } from 'rate-limit-redis';
import redis from '../config/redis';

/**
 * Why validate: false appears on every limiter here
 * ─────────────────────────────────────────────────
 * express-rate-limit performs a self-check at startup to verify that the app
 * has `app.set('trust proxy', ...)` configured correctly. Without it, req.ip
 * resolves to the Railway load-balancer IP, making ALL users share the same
 * rate-limit bucket — effectively disabling per-client throttling.
 *
 * `validate: false` suppresses that startup warning because we explicitly set
 * `app.set('trust proxy', 1)` in src/index.ts. If you ever remove that line,
 * re-enable `validate: true` here so the misconfiguration is caught at boot.
 *
 * DEPENDENCY: app.set('trust proxy', 1) in src/index.ts MUST remain in place.
 * If it is removed, rate limiters will silently apply to the proxy's IP rather
 * than the real client IP, rendering them useless.
 *
 * Redis store
 * ───────────
 * When REDIS_URL is set, all limiters use a shared RedisStore so counters are
 * consistent across multiple instances (required for horizontal scaling).
 * Without Redis the default MemoryStore is used — fine for a single instance
 * but counters reset on restart and are not shared across replicas.
 */

/**
 * Build a RedisStore for the given prefix if Redis is available,
 * otherwise return undefined (falls back to MemoryStore).
 */
function makeStore(prefix: string): RedisStore | undefined {
  if (!redis) return undefined;
  const client = redis;
  return new RedisStore({
    // ioredis v5 uses .call() — cast via SendCommandFn to satisfy rate-limit-redis v4 typings
    sendCommand: ((...args: [string, ...string[]]) => client.call(...args)) as unknown as SendCommandFn,
    prefix: `rl:${prefix}:`,
  });
}

/**
 * Global rate limit — applied to every route in the app.
 * 300 requests per minute per IP (supports ~10k concurrent users at 1 req/2s each).
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('global'),
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});

/**
 * Login rate limit — max 10 per hour, keyed by email (from body) + IP.
 * Falls back to IP-only if email is not present or not a string.
 */
export const loginRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    return email ? `login:${email}` : `login:ip:${req.ip ?? 'unknown'}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('login'),
  message: {
    success: false,
    message: 'Too many login attempts for this account. Please try again later.',
  },
});

/**
 * Student login rate limit — max 10 per hour, keyed by phone_number + IP.
 * Falls back to IP-only if phone_number is absent.
 */
export const studentLoginRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req: Request) => {
    const phone =
      typeof req.body?.phone_number === 'string'
        ? req.body.phone_number.trim()
        : '';
    return phone ? `student_login:${phone}` : `student_login:ip:${req.ip ?? 'unknown'}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('student_login'),
  message: {
    success: false,
    message: 'Too many login attempts for this account. Please try again later.',
  },
});

/**
 * Parent registration rate limit — max 5 per hour per IP.
 */
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req: Request) => `register:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('register'),
  message: {
    success: false,
    message: 'Too many registration attempts. Please try again later.',
  },
});

/**
 * Template download rate limit — max 20 per hour per IP.
 */
export const templateDownloadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req: Request) => `template:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('template'),
  message: {
    success: false,
    message: 'Too many template download requests. Please try again later.',
  },
});

/**
 * Forgot password rate limit — max 5 per hour per IP.
 * Prevents email spam / user enumeration attacks.
 */
export const forgotPasswordRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req: Request) => `forgot_pwd:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('forgot_pwd'),
  message: {
    success: false,
    message: 'Too many password reset requests. Please try again later.',
  },
});

/**
 * Test submission rate limit — max 30 per hour per student.
 * Prevents bulk/scripted test submissions.
 */
export const testSubmitRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: (req: Request) => `test_submit:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('test_submit'),
  message: {
    success: false,
    message: 'Too many test submissions. Please try again later.',
  },
});

/**
 * School list rate limit — max 30 per minute per IP.
 * The /api/schools/list endpoint is public (used on the login page) so we apply
 * a dedicated, tighter limit to prevent scraping of the school directory.
 */
export const schoolListRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: (req: Request) => `school_list:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('school_list'),
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});

/**
 * Account deletion request rate limit — max 3 per hour per IP.
 * This is a public unauthenticated endpoint that creates notifications for all
 * superadmins. Without a limit an attacker could flood the notification inbox.
 */
export const deleteAccountRequestRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req: Request) => `delete_acct:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('delete_acct'),
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});

/**
 * Student OTP request rate limit — max 3 OTP sends per hour per IP.
 * Prevents abuse of the WhatsApp OTP endpoint.
 */
export const studentOtpRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req: Request) => `student_otp:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  store: makeStore('student_otp'),
  message: {
    success: false,
    message: 'Too many OTP requests. Please try again later.',
  },
});


