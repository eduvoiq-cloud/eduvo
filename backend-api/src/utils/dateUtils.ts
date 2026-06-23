/**
 * dateUtils.ts — Shared date utilities for the Eduvo backend.
 *
 * All date helpers here are IST-aware (UTC+5:30) to ensure consistent
 * "today" comparisons across cron jobs and services that run on UTC servers.
 */

/**
 * Returns today's date string in IST (Asia/Kolkata) as YYYY-MM-DD.
 *
 * Use this everywhere you need "today" for comparison with DB date fields,
 * instead of `new Date().toISOString().slice(0, 10)` which returns UTC date
 * and breaks between midnight UTC and 5:30 AM IST.
 *
 * @example
 *   getTodayIST() // "2026-06-23"
 */
export function getTodayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  // en-CA locale formats as YYYY-MM-DD (ISO 8601 date)
}

/**
 * Returns yesterday's date string in IST (Asia/Kolkata) as YYYY-MM-DD.
 */
export function getYesterdayIST(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
