import rateLimit from 'express-rate-limit';

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
 * Strict rate limit for auth endpoints (login, register, password reset).
 * 10 requests per hour per IP.
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
