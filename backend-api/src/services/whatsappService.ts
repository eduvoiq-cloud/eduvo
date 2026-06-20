/**
 * whatsappService.ts
 *
 * Sends WhatsApp messages via the Meta Cloud API (WhatsApp Business Platform).
 * If WHATSAPP_ENABLED is not "true", logs a warning and returns without sending.
 * Never throws — callers must treat WhatsApp as best-effort.
 */

import axios from 'axios';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WhatsAppResult {
  sent: boolean;
  messageId?: string;
  reason?: string;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Pause execution for the given number of milliseconds.
 * Use between sends when sending in bulk to respect Meta rate limits.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a phone number to a bare 10-digit Indian number,
 * then prepend '91' for the WhatsApp API.
 *
 * Accepts: "9876543210", "+91 9876543210", "91-9876543210", etc.
 */
function formatPhone(raw: string): string {
  // Strip spaces, dashes, and leading '+' prefix
  let digits = raw.replace(/[\s\-+]/g, '');

  // If caller already prepended '91', strip it so we always control the prefix
  if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.slice(2);
  }

  return `91${digits}`;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp text message to the given phone number.
 *
 * @param toPhone  - 10-digit Indian mobile number (no country code needed;
 *                   we prepend "91" automatically).
 * @param message  - Plain-text message body.
 * @returns        WhatsAppResult — never throws.
 */
export async function sendWhatsAppMessage(
  toPhone: string,
  message: string
): Promise<WhatsAppResult> {
  const enabled     = process.env.WHATSAPP_ENABLED;
  const phoneId     = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion  = process.env.WHATSAPP_API_VERSION ?? 'v19.0';

  const last4   = toPhone.slice(-4);
  const preview = message.slice(0, 50);

  // ── Guard: feature flag ────────────────────────────────────────────────────
  if (enabled !== 'true') {
    console.log(
      `[WhatsApp DISABLED] Would send to ...${last4}: ${preview}...`
    );
    return { sent: false, reason: 'disabled' };
  }

  // ── Guard: credentials not configured ─────────────────────────────────────
  if (!phoneId || !accessToken) {
    console.warn(
      `[WhatsApp] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN — ` +
      `skipping send to ...${last4}`
    );
    return { sent: false, reason: 'credentials not configured' };
  }

  const to  = formatPhone(toPhone);
  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;

  // ── API call ───────────────────────────────────────────────────────────────
  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000, // 10 second timeout
      }
    );

    // Meta returns { messages: [{ id: "wamid.xxx" }] } on success
    const messageId: string | undefined =
      response.data?.messages?.[0]?.id ?? undefined;

    console.log(
      `[WhatsApp] Sent to ...${last4} — messageId: ${messageId ?? '(none)'}`
    );

    return { sent: true, messageId };
  } catch (err: unknown) {
    // Extract the most useful error detail available
    let reason: string;

    if (axios.isAxiosError(err)) {
      const status       = err.response?.status;
      const apiError     = err.response?.data?.error;
      const apiMsg       = apiError?.message ?? err.message;
      const errorCode    = apiError?.code;
      const errorSubcode = apiError?.error_subcode;

      reason = `HTTP ${status ?? 'N/A'} — ${apiMsg}` +
               (errorCode    ? ` (code: ${errorCode})`         : '') +
               (errorSubcode ? ` (subcode: ${errorSubcode})`   : '');

      console.error(
        `[WhatsApp] Failed to send to ...${last4}: ${reason}`,
        // Full response body for debugging — no PII beyond last4
        { responseData: JSON.stringify(err.response?.data ?? {}).slice(0, 500) }
      );
    } else {
      reason = err instanceof Error ? err.message : String(err);
      console.error(`[WhatsApp] Failed to send to ...${last4}:`, reason);
    }

    return { sent: false, reason };
  }
}
