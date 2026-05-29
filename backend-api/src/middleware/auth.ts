import { Request, Response, NextFunction } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { sendError } from '../utils/response';

// ── Role type ─────────────────────────────────────────────────────────────────

export type AppRole = 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';

// ── Augment Express Request ───────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        email: string;
        role: AppRole;
        school_id: string | null;
      };
    }
  }
}

/**
 * Verifies the Bearer JWT via Supabase Auth, then fetches the user's profile
 * (name, role, school_id) from the `users` table.
 *
 * Role is NEVER trusted from the JWT or frontend — it always comes from the DB.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 'Missing or malformed Authorization header', 401);
    return;
  }

  const token = authHeader.split(' ')[1];

  // 1. Verify the JWT with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData.user) {
    sendError(res, 'Invalid or expired token', 401);
    return;
  }

  const authUser = authData.user;

  // 2. Fetch the user profile from the users table (role lives here, not in JWT)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id')
    .eq('id', authUser.id)
    .single();

  if (profileError || !profile) {
    sendError(res, 'User profile not found. Contact your administrator.', 403);
    return;
  }

  req.user = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role as AppRole,
    school_id: profile.school_id ?? null,
  };

  next();
}
