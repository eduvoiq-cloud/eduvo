/**
 * Generate a random 10-character alphanumeric temporary password.
 * Used when creating teacher/admin accounts without a supplied password.
 *
 * Shared by admin.ts and superadmin.ts.
 */
export function generateTempPassword(): string {
  return (
    Math.random().toString(36).slice(2, 7).toUpperCase() +
    Math.random().toString(36).slice(2, 7)
  );
}
