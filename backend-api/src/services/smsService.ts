/**
 * smsService.ts
 *
 * Sends SMS messages via the MSG91 API.
 * If MSG91_API_KEY is not configured, logs a warning and returns false.
 * Never throws — callers must treat SMS as best-effort.
 */

import axios from 'axios';
import { supabaseAdmin } from '../config/supabase';

// ── MSG91 API constants ───────────────────────────────────────────────────────
const MSG91_API_URL = 'https://api.msg91.com/api/v5/flow/';

// ── Audit logging helper ──────────────────────────────────────────────────────
async function logSmsAudit(
  phone: string,
  success: boolean,
  details: Record<string, unknown>
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: null,
      action: success ? 'SMS_SENT' : 'SMS_FAILED',
      table_name: 'sms_service',
      details: {
        // Never log the full phone number — only last 4 digits for traceability
        phone_last4: phone.slice(-4),
        ...details,
      },
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[smsService] Failed to write SMS audit log:', err);
  }
}

/**
 * Send an SMS to the given phone number via MSG91.
 *
 * @param phone   - 10-digit Indian mobile number (no country code prefix needed here;
 *                  we prepend "91" for MSG91).
 * @param message - Plain-text message body (max ~160 chars for single SMS).
 * @returns       true if MSG91 accepted the request, false on any failure.
 */
export async function sendSMS(phone: string, message: string): Promise<boolean> {
  const apiKey   = process.env.MSG91_API_KEY;
  const senderId = process.env.MSG91_SENDER_ID ?? 'EDUVO';

  // ── Guard: API key not configured ────────────────────────────────────────────
  if (!apiKey || apiKey === 'your_msg91_api_key_here') {
    console.warn(
      `[smsService] MSG91_API_KEY not configured — skipping SMS to ...${phone.slice(-4)}`
    );
    await logSmsAudit(phone, false, { reason: 'API key not configured', message_preview: message.slice(0, 50) });
    return false;
  }

  // ── Build MSG91 payload ───────────────────────────────────────────────────────
  // MSG91 transactional SMS API (v5 — non-DLT flow for OTP/transactional)
  const payload = {
    sender:    senderId,
    route:     '4',          // Transactional route
    country:   '91',
    sms: [
      {
        message,
        to: [`91${phone}`],  // Prepend country code
      },
    ],
  };

  try {
    const response = await axios.post(MSG91_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        authkey: apiKey,
      },
      timeout: 10_000, // 10 second timeout
    });

    // MSG91 returns { type: "success", message: "..." } on success
    const success =
      response.status === 200 &&
      (response.data?.type === 'success' || response.data?.message === 'Request submitted successfully');

    if (success) {
      console.log(`[smsService] SMS sent to ...${phone.slice(-4)}`);
      await logSmsAudit(phone, true, { sender_id: senderId });
    } else {
      console.warn(
        `[smsService] MSG91 returned unexpected response for ...${phone.slice(-4)}:`,
        response.data
      );
      await logSmsAudit(phone, false, {
        reason: 'Unexpected API response',
        response_data: JSON.stringify(response.data).slice(0, 200),
      });
    }

    return success;
  } catch (err: unknown) {
    const message_err =
      err instanceof Error ? err.message : String(err);

    console.error(`[smsService] Failed to send SMS to ...${phone.slice(-4)}:`, message_err);

    await logSmsAudit(phone, false, {
      reason: message_err,
      message_preview: message.slice(0, 50),
    });

    return false;
  }
}
