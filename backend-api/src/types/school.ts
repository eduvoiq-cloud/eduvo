/**
 * Backend TypeScript type for a school record as stored in the database.
 * Mirrors the `schools` table schema.
 */
export interface School {
  id: string;
  name: string;
  address: string;
  phone?: string | null;
  email?: string | null;
  is_active: boolean;
  subscription_status: boolean;
  created_at: string;
  updated_at?: string | null;
  /** Education board the school follows (e.g. GSEB, CBSE). */
  board?: string;
  /** Template used when generating student result/report cards. */
  result_template?: string;
}
