/**
 * integrityScore.ts
 *
 * Pure integrity score calculation extracted so it can be unit-tested
 * without importing the Express router or Supabase.
 *
 * This is the canonical implementation; cronRecovery.ts and
 * studentRecovery.ts both duplicate this logic inline.
 * Tests import from here.
 */

export interface IntegrityData {
  exit_count: number;
  return_count?: number;
  total_exit_duration_seconds: number;
  longest_single_exit_seconds: number;
}

export interface IntegrityConfig {
  base_score?: number;
  exit_deduction_per_exit?: number;
  long_exit_threshold_seconds?: number;
  long_exit_extra_deduction?: number;
  suspicious_exit_count_threshold?: number;
  suspicious_duration_threshold_seconds?: number;
  suspicious_rapid_exit_count?: number;
  minimum_score?: number;
}

/**
 * Hardcoded defaults — used when the DB config table is empty or unavailable.
 * These values match the seeds in add-camera-proctoring.sql.
 */
export const INTEGRITY_DEFAULTS: Required<IntegrityConfig> = {
  base_score: 100,
  exit_deduction_per_exit: 5,
  long_exit_threshold_seconds: 120,
  long_exit_extra_deduction: 10,
  suspicious_exit_count_threshold: 5,
  suspicious_duration_threshold_seconds: 300,
  suspicious_rapid_exit_count: 8,
  minimum_score: 0,
};

export interface IntegrityResult {
  score: number;
  is_suspicious: boolean;
  suspicious_reasons: string[];
}

/**
 * calculateIntegrityScore
 *
 * @param data    Raw proctoring counters from the client.
 * @param config  Config values from the DB (partial — falls back to INTEGRITY_DEFAULTS).
 * @returns       { score, is_suspicious, suspicious_reasons }
 */
export function calculateIntegrityScore(
  data: IntegrityData,
  config: IntegrityConfig = {}
): IntegrityResult {
  const cfg: Required<IntegrityConfig> = { ...INTEGRITY_DEFAULTS, ...config };

  let score = cfg.base_score;

  // Deduct per exit
  for (let i = 0; i < data.exit_count; i++) {
    score -= cfg.exit_deduction_per_exit;
  }

  // Extra deduction for a single long exit
  if (data.longest_single_exit_seconds > cfg.long_exit_threshold_seconds) {
    score -= cfg.long_exit_extra_deduction;
  }

  // Extra deduction for extended total time outside
  if (data.total_exit_duration_seconds > cfg.suspicious_duration_threshold_seconds) {
    score -= 15;
  }

  // Floor at minimum_score (never negative by default)
  score = Math.max(score, cfg.minimum_score);
  score = Math.round(score);

  // ── Suspicion flags ────────────────────────────────────────────────────────
  let is_suspicious = false;
  const suspicious_reasons: string[] = [];

  if (data.exit_count >= cfg.suspicious_exit_count_threshold) {
    is_suspicious = true;
    suspicious_reasons.push(`High number of exits (${data.exit_count} times)`);
  }

  if (data.total_exit_duration_seconds >= cfg.suspicious_duration_threshold_seconds) {
    is_suspicious = true;
    suspicious_reasons.push(
      `Extended time outside test (${data.total_exit_duration_seconds} seconds)`
    );
  }

  const returnCount = data.return_count ?? data.exit_count; // fallback if not provided
  if (
    data.exit_count >= cfg.suspicious_rapid_exit_count &&
    data.exit_count > 0 &&
    data.total_exit_duration_seconds / data.exit_count < 30
  ) {
    is_suspicious = true;
    suspicious_reasons.push('Rapid repeated exits detected');
  }

  return { score, is_suspicious, suspicious_reasons };
}
