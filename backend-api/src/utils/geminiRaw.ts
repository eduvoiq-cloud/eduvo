/**
 * geminiRaw.ts
 *
 * Low-level Gemini REST helpers that bypass the @google/generative-ai SDK.
 *
 * WHY: SDK v0.24 does not support `thinkingConfig` in its TypeScript types.
 * When passed via `as Record<string, unknown>`, the field is present in the
 * serialized JSON but some model versions silently ignore it inside
 * `generationConfig`, causing thinking tokens to fire unexpectedly and
 * multiplying costs by 5-20x.
 *
 * Using the REST API directly guarantees the request body is exactly what
 * we specify â€” no SDK transformation, no field stripping.
 *
 * Thinking budget reference (as of July 2026):
 *   gemini-2.5-flash-lite â€” thinking OFF by default, can be enabled
 *   gemini-2.5-flash      â€” thinking ON by default, thinkingBudget:0 disables
 *   gemini-2.5-pro        â€” thinking ON by default
 *
 * For all structured-output tasks (MCQ gen, reports, evals) we always set
 * thinkingBudget:0 â€” thinking adds no quality benefit for these tasks.
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
  /** Default: true (always disable thinking for cost) */
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
 * Makes a single generateContent REST call to the Gemini API.
 * Always disables thinking tokens unless `disableThinking: false` is passed.
 * Returns the raw response text.
 *
 * Throws on non-2xx HTTP status.
 */
export async function geminiRawGenerate(req: GeminiRawRequest): Promise<{ text: string; totalTokens: number; thinkingTokens: number }> {
  const { apiKey, model, parts, systemInstruction, responseSchema, disableThinking = true } = req;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(responseSchema ? { responseSchema } : {}),
      ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
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
 * Both calls use `thinkingBudget: 0`.
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
        console.warn(`[geminiRaw] ${model} returned retryable error, trying fallback ${fallbackModel}â€¦`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
