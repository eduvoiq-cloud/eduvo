import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabase, supabaseAdmin } from '../config/supabase';
import { sendError } from '../utils/response';
import redis from '../config/redis';

// ── Role type ─────────────────────────────────────────────────────────────────

/**
 * 'parent' is kept here for backward compatibility with existing routes.
 * New code should not create parent accounts — parents use student credentials.
 * Remove 'parent' from this union once all routes have been migrated.
 */
export type AppRole = 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';

// ── JWT payload shapes ────────────────────────────────────────────────────────

export interface StaffJwtPayload {
  type: 'staff';
  sub: string; // Supabase auth user id
}

export interface StudentJwtPayload {
  type: 'student';
  sub: string; // students.id (uuid)
  school_id: string;
}

// ── Augment Express Request ───────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Populated for staff tokens (superadmin / schooladmin / teacher) */
      user?: {
        id: string;
        name: string;
        email: string;
        role: AppRole;
        school_id: string | null;
        /** The JWT's original school_id before any X-School-ID override */
        primary_school_id: string | null;
      };
      /** Populated for student tokens */
      student?: {
        id: string;
        name: string;
        phone_number: string;
        class_name: string | null;
        section: string | null;
        school_id: string;
        is_first_login: boolean;
      };
      /** Which token type was presented — useful for /me */
      tokenType?: 'staff' | 'student';
    }
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/**
 * Auth cache TTL in seconds.
 * 5 minutes balances freshness (deactivations, role changes) with DB load.
 * Profile data (role, school_id, subscription) rarely changes mid-session,
 * so 60s was unnecessarily aggressive and caused excess Supabase calls at scale.
 */
const AUTH_CACHE_TTL = 300;

/** Prefix keys to avoid collisions with rate-limit keys */
const CACHE_PREFIX_STAFF   = 'auth:staff:';
const CACHE_PREFIX_STUDENT = 'auth:student:';

async function getCached<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // cache miss on error — fall through to DB
  }
}

async function setCached(key: string, value: unknown): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(key, AUTH_CACHE_TTL, JSON.stringify(value));
  } catch {
    // Non-fatal — cache write failure is fine, next request will re-fetch
  }
}

/**
 * Invalidate cached auth entries for a given token.
 * Call this after password changes, account deactivation, or role updates.
 */
export async function invalidateAuthCache(token: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`${CACHE_PREFIX_STAFF}${token}`);
    await redis.del(`${CACHE_PREFIX_STUDENT}${token}`);
  } catch {
    // Non-fatal
  }
}

// ── Student token blocklist (revocation) ──────────────────────────────────────
//
// Student JWTs are stateless (no Supabase session to invalidate), so we
// maintain a Redis blocklist. Blocked tokens are rejected by authenticateStudent
// before profile lookup — effectively revoking them server-side.
//
// TTL matches the token lifetime. Since we now use 10-year tokens, cap the
// blocklist entry at 365 days — long enough to cover any realistic session,
// and Redis will automatically expire the key.
const BLOCKLIST_PREFIX = 'auth:blocked:';
const STUDENT_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

/**
 * Add a student JWT to the revocation blocklist.
 * No-op when Redis is unavailable (graceful degradation).
 */
export async function blockStudentToken(token: string): Promise<void> {
  if (!redis) return;
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await redis.setex(`${BLOCKLIST_PREFIX}${hash}`, STUDENT_TOKEN_TTL_SECONDS, '1');
  } catch {
    // Non-fatal — token blocklist is defence-in-depth; worst case it expires naturally
  }
}

/**
 * Check whether a student JWT has been revoked.
 * Returns false when Redis is unavailable (fails open — prefer availability
 * over locking out all students if Redis goes down).
 * Logs a warning so ops can detect a Redis outage quickly.
 */
async function isStudentTokenBlocked(token: string): Promise<boolean> {
  if (!redis) {
    // Redis is not configured — blocklist is not enforced.
    // This is expected in dev but should not happen in production.
    if (process.env.NODE_ENV === 'production') {
      console.warn('[auth] Redis unavailable — student token revocation blocklist is NOT enforced');
    }
    return false;
  }
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const val = await redis.get(`${BLOCKLIST_PREFIX}${hash}`);
    return val === '1';
  } catch (err) {
    console.warn('[auth] Redis error checking token blocklist — failing open:', (err as Error).message);
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1];
}

/** UUID v4 format check. Used to sanitize X-School-ID before it hits the DB. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/** Paths that are always allowed regardless of password-reset / first-login state */
const ALWAYS_ALLOWED_STAFF_PATHS = [
  '/api/auth/staff/change-password',
  '/api/auth/me',
  '/api/auth/logout',
];

const ALWAYS_ALLOWED_STUDENT_PATHS = [
  '/api/auth/student/change-password',
  '/api/auth/me',
  '/api/auth/logout',
];

function isPathAllowed(req: Request, paths: string[]): boolean {
  return paths.some((p) => req.path === p || req.originalUrl.endsWith(p));
}

// ── Cached profile shapes (what we store in Redis) ────────────────────────────

interface CachedStaffProfile {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  school_id: string | null;
  must_reset_password: boolean;
  is_deleted: boolean;
  subscription_active: boolean | null; // null = superadmin (not checked)
}

interface CachedStudentProfile {
  id: string;
  full_name: string;
  phone_number: string;
  class_name: string | null;
  section: string | null;
  school_id: string;
  is_first_login: boolean;
  subscription_active: boolean;
}

// ── Staff profile loader (with Redis cache) ───────────────────────────────────

async function loadStaffProfile(
  supabaseUserId: string,
  token: string
): Promise<CachedStaffProfile | null> {
  const cacheKey = `${CACHE_PREFIX_STAFF}${token}`;

  const cached = await getCached<CachedStaffProfile>(cacheKey);
  if (cached) return cached;

  // Not in cache — fetch from DB
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, must_reset_password, is_deleted')
    .eq('id', supabaseUserId)
    .single();

  if (profileError || !profile) return null;

  let subscription_active: boolean | null = null;

  if ((profile.role as AppRole) !== 'superadmin' && profile.school_id) {
    const { data: schoolStatus } = await supabaseAdmin
      .from('schools')
      .select('subscription_status')
      .eq('id', profile.school_id)
      .single();

    subscription_active =
      (schoolStatus as { subscription_status: boolean } | null)?.subscription_status ?? false;
  }

  const result: CachedStaffProfile = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role as AppRole,
    school_id: (profile.school_id as string | null) ?? null,
    must_reset_password: (profile as Record<string, unknown>).must_reset_password === true,
    is_deleted: (profile as Record<string, unknown>).is_deleted === true,
    subscription_active,
  };

  await setCached(cacheKey, result);
  return result;
}

// ── Student profile loader (with Redis cache) ─────────────────────────────────

async function loadStudentProfile(
  studentId: string,
  token: string
): Promise<CachedStudentProfile | null> {
  const cacheKey = `${CACHE_PREFIX_STUDENT}${token}`;

  const cached = await getCached<CachedStudentProfile>(cacheKey);
  if (cached) return cached;

  const { data: student, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, phone_number, class_name, section, school_id, is_first_login')
    .eq('id', studentId)
    .single();

  if (error || !student) return null;

  const { data: studentSchool } = await supabaseAdmin
    .from('schools')
    .select('subscription_status')
    .eq('id', student.school_id)
    .single();

  const subscription_active =
    (studentSchool as { subscription_status: boolean } | null)?.subscription_status ?? false;

  const result: CachedStudentProfile = {
    id: student.id,
    full_name: student.full_name,
    phone_number: student.phone_number,
    class_name: student.class_name ?? null,
    section: student.section ?? null,
    school_id: student.school_id,
    is_first_login: student.is_first_login ?? false,
    subscription_active,
  };

  await setCached(cacheKey, result);
  return result;
}

// ── Staff authenticate ────────────────────────────────────────────────────────

/**
 * Verifies a staff Bearer JWT via Supabase Auth, then fetches the user's
 * profile (name, role, school_id) from the `users` table (cached in Redis).
 *
 * Role is NEVER trusted from the JWT — it always comes from the DB.
 * Rejects student tokens.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    sendError(res, 'Missing or malformed Authorization header', 401);
    return;
  }

  // ── Try decoding as a custom student JWT first ────────────────────────────
  // If it is a student token, reject it here — staff routes only.
  try {
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const decoded = jwt.verify(token, secret) as StudentJwtPayload;
      if (decoded?.type === 'student') {
        sendError(res, 'Student tokens cannot access staff routes', 403);
        return;
      }
    }
  } catch {
    // Not a custom JWT — fall through to Supabase verification
  }

  // ── Verify with Supabase Auth ─────────────────────────────────────────────
  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData.user) {
    sendError(res, 'Invalid or expired token', 401);
    return;
  }

  // ── Load profile (cached) ─────────────────────────────────────────────────
  const profile = await loadStaffProfile(authData.user.id, token);

  if (!profile) {
    sendError(res, 'User profile not found. Contact your administrator.', 403);
    return;
  }

  if (profile.is_deleted) {
    sendError(res, 'This account has been deactivated.', 403);
    return;
  }

  if (profile.must_reset_password && !isPathAllowed(req, ALWAYS_ALLOWED_STAFF_PATHS)) {
    sendError(res, 'You must change your password before accessing this resource.', 403);
    return;
  }

  if (profile.role !== 'superadmin' && profile.subscription_active === false) {
    sendError(
      res,
      'Your subscription has expired. Please renew your subscription to continue using the service.',
      402
    );
    return;
  }

  const primarySchoolId = profile.school_id;
  let activeSchoolId = primarySchoolId;

  // ── X-School-ID override (multi-school admin switcher) ────────────────────
  const requestedSchoolId = req.headers['x-school-id'] as string | undefined;
  if (
    requestedSchoolId &&
    profile.role === 'schooladmin' &&
    requestedSchoolId !== primarySchoolId
  ) {
    // Validate UUID format before it hits the DB
    if (!isValidUuid(requestedSchoolId)) {
      sendError(res, 'Invalid X-School-ID format', 400);
      return;
    }

    const { data: accessRow } = await supabaseAdmin
      .from('school_admin_access')
      .select('school_id')
      .eq('admin_id', profile.id)
      .eq('school_id', requestedSchoolId)
      .maybeSingle();

    if (accessRow) {
      activeSchoolId = requestedSchoolId;
    }
  }

  req.user = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role,
    school_id: activeSchoolId,
    primary_school_id: primarySchoolId,
  };
  req.tokenType = 'staff';

  next();
}

// ── Student authenticate ──────────────────────────────────────────────────────

/**
 * Verifies a custom student JWT (signed with JWT_SECRET).
 * Fetches the student's profile from the `students` table (cached in Redis).
 * Rejects staff tokens.
 */
export async function authenticateStudent(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    sendError(res, 'Missing or malformed Authorization header', 401);
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    sendError(res, 'Server misconfiguration: JWT_SECRET not set', 500);
    return;
  }

  let payload: StudentJwtPayload;
  try {
    payload = jwt.verify(token, secret) as StudentJwtPayload;
  } catch {
    sendError(res, 'Invalid or expired token', 401);
    return;
  }

  if (payload.type !== 'student') {
    sendError(res, 'Staff tokens cannot access student routes', 403);
    return;
  }

  // Check revocation blocklist before hitting the DB/cache
  if (await isStudentTokenBlocked(token)) {
    sendError(res, 'Token has been revoked. Please log in again.', 401);
    return;
  }

  const student = await loadStudentProfile(payload.sub, token);

  if (!student) {
    sendError(res, 'Student not found', 403);
    return;
  }

  if (!student.subscription_active) {
    sendError(
      res,
      'Your subscription has expired. Please renew your subscription to continue using the service.',
      402
    );
    return;
  }

  if (student.is_first_login && !isPathAllowed(req, ALWAYS_ALLOWED_STUDENT_PATHS)) {
    sendError(res, 'You must change your password before accessing this resource.', 403);
    return;
  }

  req.student = {
    id: student.id,
    name: student.full_name,
    phone_number: student.phone_number,
    class_name: student.class_name,
    section: student.section,
    school_id: student.school_id,
    is_first_login: student.is_first_login,
  };
  req.tokenType = 'student';

  next();
}

// ── authenticateAny ───────────────────────────────────────────────────────────

/**
 * Accepts either a staff token OR a student token.
 *
 * Composes authenticateStudent and authenticate rather than duplicating their
 * logic — if the student path succeeds we return early, otherwise we fall
 * through to the staff path. All security gates (subscription, first-login,
 * must_reset_password, is_deleted) are enforced by the underlying middlewares.
 */
export async function authenticateAny(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    sendError(res, 'Missing or malformed Authorization header', 401);
    return;
  }

  const secret = process.env.JWT_SECRET;

  // ── Try student JWT first ─────────────────────────────────────────────────
  if (secret) {
    try {
      const payload = jwt.verify(token, secret) as StudentJwtPayload;
      if (payload?.type === 'student') {
        // Delegate entirely to authenticateStudent — no logic duplication
        return authenticateStudent(req, res, next);
      }
    } catch {
      // Not a valid student JWT — fall through to Supabase
    }
  }

  // ── Try Supabase staff JWT ────────────────────────────────────────────────
  // Delegate entirely to authenticate — no logic duplication
  return authenticate(req, res, next);
}
