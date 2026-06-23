/**
 * integrity.unit.test.ts
 *
 * Unit tests for the test integrity score calculation.
 * Pure function tests — no database, no HTTP requests.
 *
 * Plain language: These tests verify that the integrity score (which shows
 * teachers if a student was cheating by leaving the app) is calculated
 * correctly, with the right score for the right behaviour.
 */

import {
  calculateIntegrityScore,
  INTEGRITY_DEFAULTS,
  IntegrityConfig,
} from '../utils/integrityScore';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Integrity Score Calculation', () => {

  // ── TEST 3.1 ──────────────────────────────────────────────────────────────
  it('gives a perfect score of 100 to a student who never left the app', () => {
    const result = calculateIntegrityScore({
      exit_count: 0,
      total_exit_duration_seconds: 0,
      longest_single_exit_seconds: 0,
    });

    expect(result.score).toBe(100);
    expect(result.is_suspicious).toBe(false);
    expect(result.suspicious_reasons).toEqual([]);
  });

  // ── TEST 3.2 ──────────────────────────────────────────────────────────────
  it('deducts one exit penalty for a single short exit (under long_exit_threshold)', () => {
    // One exit, 20 seconds — under the 120s long-exit threshold
    // Expected deduction: exit_deduction_per_exit (5) only
    // Expected score: 100 - 5 = 95
    const result = calculateIntegrityScore({
      exit_count: 1,
      total_exit_duration_seconds: 20,
      longest_single_exit_seconds: 20, // under 120s threshold
    });

    expect(result.score).toBe(100 - INTEGRITY_DEFAULTS.exit_deduction_per_exit);
    expect(result.score).toBe(95);
    expect(result.is_suspicious).toBe(false);
  });

  // ── TEST 3.3 ──────────────────────────────────────────────────────────────
  it('applies both exit and long-exit deductions for a single long exit (over 120s)', () => {
    // One exit, 300 seconds — over the 120s long-exit threshold
    // But 300s does NOT exceed suspicious_duration_threshold (300s) unless >= threshold
    // 300 is NOT > 300, so no "extended time outside" extra deduction
    // Score: 100 - 5 (exit) - 10 (long exit) = 85
    const result = calculateIntegrityScore({
      exit_count: 1,
      total_exit_duration_seconds: 119, // under suspicious threshold
      longest_single_exit_seconds: 300, // over long_exit_threshold (120s)
    });

    const expected =
      INTEGRITY_DEFAULTS.base_score
      - INTEGRITY_DEFAULTS.exit_deduction_per_exit     // 5
      - INTEGRITY_DEFAULTS.long_exit_extra_deduction;  // 10

    expect(result.score).toBe(expected); // 85
    expect(result.is_suspicious).toBe(false); // single exit is not suspicious
  });

  // ── TEST 3.4 ──────────────────────────────────────────────────────────────
  it('flags as suspicious when exit_count reaches the suspicious threshold (5)', () => {
    // 5 exits at the exact threshold, short durations each
    const threshold = INTEGRITY_DEFAULTS.suspicious_exit_count_threshold; // 5

    const result = calculateIntegrityScore({
      exit_count: threshold,
      total_exit_duration_seconds: 10, // very short — under suspicious duration threshold
      longest_single_exit_seconds: 2,
    });

    expect(result.is_suspicious).toBe(true);
    expect(result.suspicious_reasons).toContain(
      `High number of exits (${threshold} times)`
    );
  });

  // ── TEST 3.5 ──────────────────────────────────────────────────────────────
  it('flags as suspicious when total_exit_duration meets the suspicious duration threshold', () => {
    const durationThreshold = INTEGRITY_DEFAULTS.suspicious_duration_threshold_seconds; // 300

    const result = calculateIntegrityScore({
      exit_count: 2,
      total_exit_duration_seconds: durationThreshold, // exactly at threshold
      longest_single_exit_seconds: 150,               // over long_exit_threshold
    });

    expect(result.is_suspicious).toBe(true);
    expect(result.suspicious_reasons).toContain(
      `Extended time outside test (${durationThreshold} seconds)`
    );
  });

  // ── TEST 3.6 ──────────────────────────────────────────────────────────────
  it('clamps the score to 0 and never goes negative with extreme violations', () => {
    // 100 exits × 5 deduction each = -400 before clamping
    const result = calculateIntegrityScore({
      exit_count: 100,
      total_exit_duration_seconds: 10000,
      longest_single_exit_seconds: 5000,
    });

    expect(result.score).toBe(0);       // clamped to minimum_score (0)
    expect(result.is_suspicious).toBe(true);
  });

  // ── TEST 3.7 ──────────────────────────────────────────────────────────────
  it('uses INTEGRITY_DEFAULTS when an empty config is passed (no crash, no zero score)', () => {
    // Passing {} should fall back to INTEGRITY_DEFAULTS, not crash or score 0 incorrectly
    const emptyConfig: IntegrityConfig = {};

    const result = calculateIntegrityScore(
      {
        exit_count: 0,
        total_exit_duration_seconds: 0,
        longest_single_exit_seconds: 0,
      },
      emptyConfig
    );

    // Should use base_score = 100 from defaults
    expect(result.score).toBe(INTEGRITY_DEFAULTS.base_score);
    expect(result.is_suspicious).toBe(false);
    expect(result.suspicious_reasons).toEqual([]);
  });

  // ── Extra: custom config overrides defaults ───────────────────────────────
  it('respects a custom config that overrides individual defaults', () => {
    const customConfig: IntegrityConfig = {
      base_score: 50,
      exit_deduction_per_exit: 10,
    };

    // 2 exits × 10 deduction = 30; no long exit, no suspicious duration
    const result = calculateIntegrityScore(
      {
        exit_count: 2,
        total_exit_duration_seconds: 10,
        longest_single_exit_seconds: 10,
      },
      customConfig
    );

    expect(result.score).toBe(30); // 50 - 10 - 10
  });

  // ── Extra: rapid exits pattern ───────────────────────────────────────────
  it('flags rapid repeated exits when average duration per exit is under 30 seconds', () => {
    const rapidExitCount = INTEGRITY_DEFAULTS.suspicious_rapid_exit_count; // 8

    // 8 exits, total 80 seconds → avg 10s each → qualifies as rapid
    const result = calculateIntegrityScore({
      exit_count: rapidExitCount,
      total_exit_duration_seconds: 80,
      longest_single_exit_seconds: 15,
    });

    expect(result.is_suspicious).toBe(true);
    expect(result.suspicious_reasons).toContain('Rapid repeated exits detected');
  });
});
