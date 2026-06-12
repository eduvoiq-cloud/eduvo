import { supabaseAdmin } from '../config/supabase';

/**
 * Write a row to audit_logs.
 * Errors are swallowed so they never break the calling route.
 *
 * Shared by all route files — import this instead of defining a local logAudit.
 *
 * @param userId    The user performing the action (null for system/cron actions)
 * @param action    Short action identifier e.g. 'STUDENT_CREATED'
 * @param tableName Target table name (optional — defaults to empty string)
 * @param details   Arbitrary metadata to store alongside the log entry
 */
export async function logAudit(
  userId: string | null,
  action: string,
  tableNameOrDetails?: string | Record<string, unknown>,
  details: Record<string, unknown> = {}
): Promise<void> {
  // Support both (userId, action, details) and (userId, action, tableName, details)
  let tableName = '';
  let resolvedDetails = details;
  if (typeof tableNameOrDetails === 'string') {
    tableName = tableNameOrDetails;
    resolvedDetails = details;
  } else if (tableNameOrDetails && typeof tableNameOrDetails === 'object') {
    tableName = '';
    resolvedDetails = tableNameOrDetails;
  }

  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      table_name: tableName || null,
      details: resolvedDetails,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}
