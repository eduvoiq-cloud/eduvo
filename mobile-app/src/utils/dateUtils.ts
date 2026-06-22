/**
 * Shared date/time utilities used across multiple screens.
 */

/**
 * Parse an ISO timestamp as UTC. Supabase may return timestamptz values without
 * a timezone designator, which JavaScript would interpret as local time — causing
 * timestamps to appear shifted by the device UTC offset (e.g. +5:30h for IST).
 */
export function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

/**
 * Format an ISO timestamp as a localised time string (e.g. "02:30 PM").
 */
export function formatTime(iso: string): string {
  const d = parseUtcDate(iso);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a relative "time ago" string from an ISO timestamp.
 */
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - parseUtcDate(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  return parseUtcDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Convert an "HH:MM" string to minutes since midnight.
 */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Current time in IST (UTC+5:30) expressed as minutes since midnight.
 * The app stores all time windows in IST, so comparisons must use IST
 * regardless of the device's local timezone.
 */
export function nowISTMinutes(): number {
  const nowUTC = Date.now();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // UTC+5:30
  const istDate = new Date(nowUTC + istOffsetMs);
  return istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
}

/**
 * Current time in IST as a Date object (useful for countdown seconds).
 */
export function nowIST(): Date {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  return new Date(Date.now() + istOffsetMs);
}

/**
 * Format an "HH:MM" 24h string as "H:MM AM/PM".
 */
export function formatHHMM(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}
