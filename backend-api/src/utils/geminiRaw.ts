/**
 * geminiRaw.ts
 *
 * Low-level Gemini REST helpers that bypass the @google/generative-ai SDK.
 *
 * Thinking config reference (generateContent API, July 2026):
 *   gemini-2.5-flash-lite — thinking OFF by default; no config needed
 *   gemini-2.5-flash      — thinking ON by default; set thinking_level:"minimal" to cut cost
 *   gemini-2.5-pro        — thinking ON by default
 *
 * IMPORTANT: thinkingBudget:0 is DEPRECATED and silently ignored by the API.
 * The correct approach is thinking_level:"minimal" for gemini-2.5-flash.
 * For flash-lite, thinking is off by default so no config is needed.
 */

export interface GeminiRawPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiRawRequest {
  apiKey: string;
  model: string;
  parts: GeminiRawPart[];
  systemInstruction?: string;
  responseSchema?: Record<string, unknown>;
  /** Default: true — sets thinking_level:"minimal" on flash models to cut cost */
  disableThinking?: boolean;
}

interface GeminiRawResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Returns the correct thinkingConfig for a given model.
 *
 * - gemini-2.5-flash and similar: thinking is ON by default.
 *   Use thinking_level:"minimal" to keep thinking cost as low as possible.
 *   NOTE: thinkingBudget:0 is deprecated and ignored — do NOT use it.
 *
 * - gemini-2.5-flash-lite: thinking is OFF by default.
 *   No config needed — omitting thinkingConfig keeps it off.
 *
 * - gemini-2.5-pro: thinking is always on, cannot be disabled.
 *   Use thinking_level:"low" to minimise cost.
 */
function getThinkingConfig(model: string, disableThinking: boolean): Record<string, unknown> | null {
  if (!disableThinking) return null;

  // Flash-lite: thinking is OFF by default — no config needed
  if (model.includes('flash-lite')) return null;

  // Flash (non-lite): thinking is ON by default — use minimal to cut cost
  if (model.includes('flash')) {
    return { thinking_level: 'minimal' };
  }

  // Pro: thinking is always on — use low to minimise cost
  if (model.includes('pro')) {
    return { thinking_level: 'low' };
  }

  // Unknown model — try minimal as safe default
  return { thinking_level: 'minimal' };
}

/**
 * Makes a single generateContent REST call to the Gemini API.
 * Sets thinking_level:"minimal" on flash models to minimise thinking cost.
 * Returns the raw response text.
 *
 * Throws on non-2xx HTTP status.
 */
export async function geminiRawGenerate(req: GeminiRawRequest): Promise<{ text: string; totalTokens: number; thinkingTokens: number }> {
  const { apiKey, model, parts, systemInstruction, responseSchema, disableThinking = true } = req;

  const thinkingConfig = getThinkingConfig(model, disableThinking);

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    ...(responseSchema ? { responseSchema } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status} (${model}): ${errText}`);
  }

  const data = await response.json() as GeminiRawResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const totalTokens = data.usageMetadata?.totalTokenCount ?? 0;
  const thinkingTokens = data.usageMetadata?.thoughtsTokenCount ?? 0;

  if (thinkingTokens > 0) {
    console.warn(`[geminiRaw] thinking tokens fired: ${thinkingTokens} on model=${model} — review thinkingConfig`);
  }

  return { text, totalTokens, thinkingTokens };
}

/**
 * Convenience: call Gemini and parse the result as JSON.
 * Strips markdown fences if present.
 */
export async function geminiRawGenerateJSON<T>(req: GeminiRawRequest): Promise<{ data: T; totalTokens: number; thinkingTokens: number }> {
  const { text, totalTokens, thinkingTokens } = await geminiRawGenerate(req);

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const data = JSON.parse(cleaned) as T;
  return { data, totalTokens, thinkingTokens };
}

/**
 * Try `primaryModel` first; if it returns 503 or 429, retry with `fallbackModel`.
 */
export async function geminiRawWithFallback(
  primaryModel: string,
  fallbackModel: string,
  req: Omit<GeminiRawRequest, 'model'>,
): Promise<{ text: string; totalTokens: number; thinkingTokens: number; modelUsed: string }> {
  const models = primaryModel === fallbackModel ? [primaryModel] : [primaryModel, fallbackModel];

  let lastErr: unknown;
  for (const model of models) {
    try {
      const result = await geminiRawGenerate({ ...req, model });
      return { ...result, modelUsed: model };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = msg.includes('503') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('overloaded');
      if (isRetryable && model !== fallbackModel) {
        console.warn(`[geminiRaw] ${model} returned retryable error, trying fallback ${fallbackModel}...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
