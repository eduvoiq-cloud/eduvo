import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error(
    'Missing Supabase environment variables. Check SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in .env'
  );
}

// Node 20 does not have native WebSocket — provide `ws` as the transport
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realtimeOpts = { transport: ws as any };

/**
 * Public client — uses the anon key.
 * Safe for operations that respect Row Level Security (RLS).
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: realtimeOpts,
});

/**
 * Admin client — uses the service role key.
 * Bypasses RLS. Use only in trusted server-side code (e.g. audit logging, admin ops).
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  realtime: realtimeOpts,
});
