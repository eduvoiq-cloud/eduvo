import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase, supabaseAdmin } from '../config/supabase';
import { sendError } from '../utils/response';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1];
}

// ── Staff authenticate ────────────────────────────────────────────────────────

/**
 * Verifies a staff Bearer JWT via Supabase Auth, then fetches the user's
 * profile (name, role, school_id) from the `users` table.
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

  const authUser = authData.user;

  // ── Fetch profile from users table ───────────────────────────────────────
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, is_deleted')
    .eq('id', authUser.id)
    .single();

  if (profileError || !profile) {
    sendError(res, 'User profile not found. Contact your administrator.', 403);
    return;
  }

  if (profile.is_deleted) {
    sendError(res, 'This account has been deactivated.', 403);
    return;
  }

  req.user = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role as AppRole,
    school_id: profile.school_id ?? null,
  };
  req.tokenType = 'staff';

  next();
}

// ── Student authenticate ──────────────────────────────────────────────────────

/**
 * Verifies a custom student JWT (signed with JWT_SECRET).
 * Fetches the student's profile from the `students` table.
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

  const { data: student, error } = await supabaseAdmin
    .from('students')
    .select('id, name, phone_number, class_name, section, school_id, is_first_login')
    .eq('id', payload.sub)
    .single();

  if (error || !student) {
    sendError(res, 'Student not found', 403);
    return;
  }

  req.student = {
    id: student.id,
    name: student.name,
    phone_number: student.phone_number,
    class_name: student.class_name ?? null,
    section: student.section ?? null,
    school_id: student.school_id,
    is_first_login: student.is_first_login ?? false,
  };
  req.tokenType = 'student';

  next();
}

/**
 * Accepts either a staff token OR a student token.
 * Used by /api/auth/me to restore any session.
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
        const { data: student, error } = await supabaseAdmin
          .from('students')
          .select('id, name, phone_number, class_name, section, school_id, is_first_login')
          .eq('id', payload.sub)
          .single();

        if (!error && student) {
          req.student = {
            id: student.id,
            name: student.name,
            phone_number: student.phone_number,
            class_name: student.class_name ?? null,
            section: student.section ?? null,
            school_id: student.school_id,
            is_first_login: student.is_first_login ?? false,
          };
          req.tokenType = 'student';
          return next();
        }
      }
    } catch {
      // Not a valid student JWT — fall through to Supabase
    }
  }

  // ── Try Supabase staff JWT ────────────────────────────────────────────────
  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData.user) {
    sendError(res, 'Invalid or expired token', 401);
    return;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id, is_deleted')
    .eq('id', authData.user.id)
    .single();

  if (profileError || !profile || profile.is_deleted) {
    sendError(res, 'User profile not found or account deactivated', 403);
    return;
  }

  req.user = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role as AppRole,
    school_id: profile.school_id ?? null,
  };
  req.tokenType = 'staff';

  next();
}
