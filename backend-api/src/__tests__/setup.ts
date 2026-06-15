/**
 * Jest setup — runs before any test module is loaded.
 * Provides fake env vars so supabase.ts can import without throwing.
 */

process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.JWT_SECRET = 'test-jwt-secret-for-integration-tests-only';
process.env.NODE_ENV = 'test';

// Disable rate limits in tests — they share the same IP and would flake.
jest.mock('../middleware/rateLimit', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    globalRateLimit: passthrough,
    loginRateLimit: passthrough,
    studentLoginRateLimit: passthrough,
    forgotPasswordRateLimit: passthrough,
    registerRateLimit: passthrough,
  };
});

// Audit writes hit Supabase — mock so tests stay offline.
jest.mock('../utils/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));
