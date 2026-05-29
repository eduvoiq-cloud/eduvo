import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Global rate limit — applied to every route in the app.
 * 100 requests per minute per IP.
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
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
  message: {
    success: false,
    message: 'Too many template download requests. Please try again later.',
  },
});

/**
 * Legacy alias kept for any routes that still import authRateLimit.
 * Points to loginRateLimit behaviour (10/hour per IP).
 * @deprecated Use loginRateLimit or registerRateLimit instead.
 */
export const authRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.',
  },
});
