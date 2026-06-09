import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Global rate limit — applied to every route in the app.
 * 300 requests per minute per IP (supports ~10k concurrent users at 1 req/2s each).
 * In production, Railway sits behind a load balancer so we trust the X-Forwarded-For
 * header — the `validate: false` flag suppresses the express-rate-limit warning.
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // suppresses "trust proxy" warning; Railway handles the proxy
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
  message: {
    success: false,
    message: 'Too many test submissions. Please try again later.',
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
  validate: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.',
  },
});
