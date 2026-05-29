import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';
import type { AppRole } from './auth';

/**
 * Role hierarchy for EduFlow:
 *
 *   superadmin  — full platform access
 *   schooladmin — manages a single school
 *   teacher     — manages classes, marks, attendance within their school
 *   parent      — read-only access to their own children's data
 *   student     — read-only access to their own data
 */

/**
 * Returns middleware that allows only the specified roles.
 * Must be placed AFTER the `authenticate` middleware.
 *
 * @example
 *   router.post('/schools', authenticate, requireRole('superadmin'), handler)
 *   router.get('/marks',    authenticate, requireRole('superadmin', 'schooladmin', 'teacher'), handler)
 */
export function requireRole(...allowedRoles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'Unauthenticated', 401);
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      sendError(
        res,
        `Access denied. Required role(s): ${allowedRoles.join(', ')}`,
        403
      );
      return;
    }

    next();
  };
}

/**
 * Convenience: allow superadmin + any additional roles.
 * Superadmin always has access to everything.
 */
export function requireAtLeast(...roles: AppRole[]) {
  const allowed: AppRole[] = ['superadmin', ...roles];
  return requireRole(...allowed);
}
