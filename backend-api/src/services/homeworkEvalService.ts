/**
 * homeworkEvalService.ts
 *
 * Overnight batch AI evaluation engine for homework submissions.
 *
 * Evaluation pipeline per submission:
 *   1. Skip flagged_for_review submissions (teacher handles those).
 *   2. Check evaluation cache (question_hash + answer_hash) â€” FREE path.
 *   3. Pure numerical: regex compare â€” ZERO AI cost.
 *   4. Typed theory/mixed: Gemini Flash text evaluation.
 *   5. Photo submissions: Gemini Flash vision evaluation.
 *   6. Route by confidence threshold (â‰¥0.9 â†’ checked, <0.9 â†’ flagged_for_review).
 *   7. Suspicious-text detection for typed answers if teacher opted in.
 *   8. Cache successful typed evaluations for future reuse.
 */

import crypto from 'crypto';
import { geminiRawGenerate } from '../utils/geminiRaw';
import { supabaseAdmin } from '../config/supabase';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EvalResult {
  result: 'correct' | 'incorrect' | 'partial' | 'unclear';
  confidence: number;
  feedback: string;
}

interface HomeworkRow {
  id: string;
  title: string;
  class_name: string;
  section: string;
  school_id: string;
  subject_type: string | null;
  reference_answer: string | null;
  reference_file_url: string | null;
  min_word_count: number | null;
  requires_diagram: boolean;
  check_suspicious: boolean;
  subjects: { name: string } | null;
}

interface SubmissionRow {
  id: string;
  student_id: string;
  homework_id: string;
  submission_text: string | null;
  submission_image_urls: string[] | null;
  status: string;
  queued_overflow: boolean;
}

interface BatchStats {
  total: number;
  cache_hits: number;
  numerical: number;
  typed_ai: number;
  photo_ai: number;
  checked: number;
  flagged: number;
  errors: number;
  overflow_skipped: number;
}

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CONFIDENCE_THRESHOLD = 0.9;

/**
 * Daily per-student limit for AI-checked submissions across all subjects.
 * If a student exceeds this, subsequent submissions are stored with
 * queued_overflow=true and picked up in the next day's batch.
 */
const MAX_AI_CHECKS_PER_STUDENT_PER_DAY = 5;

/**
 * Gemini 2.5 Flash pricing (INR) â€” configurable via env.
 * Adjust these constants when Google changes pricing.
 *
 * Default approximate values (as of 2025):
 *   Text input:    â‚¹0.00006 per 1K tokens  (â‰ˆ $0.00007)
 *   Text output:   â‚¹0.00025 per 1K tokens  (â‰ˆ $0.0003)
 *   Vision input:  â‚¹0.00006 per 1K tokens  (same as text for Flash)
 *
 * We use a flat per-call estimate since we don't track token counts
 * in the homework eval service (Gemini JS SDK doesn't always return
 * usage metadata for streaming calls without extra config).
 *
 * Per-call cost estimate (conservative):
 *   Text eval:   ~2000 tokens total â†’ â‚¹0.00062 per call
 *   Vision eval: ~3000 tokens total â†’ â‚¹0.00093 per call
 */
const COST_PER_TEXT_CALL_INR = parseFloat(
  process.env.GEMINI_COST_TEXT_INR ?? '0.00062'
);
const COST_PER_VISION_CALL_INR = parseFloat(
  process.env.GEMINI_COST_VISION_INR ?? '0.00093'
);

// Simple sentence-complexity heuristics per class band
// If avg words-per-sentence > threshold for class â†’ suspiciously complex
const SUSPICIOUS_WPS_BY_CLASS: Record<string, number> = {
  '1': 8, '2': 9, '3': 10, '4': 11, '5': 13,
  '6': 15, '7': 16, '8': 18, '9': 20, '10': 22,
  '11': 25, '12': 28,
};
const DEFAULT_SUSPICIOUS_WPS = 22;
const SUSPICIOUS_MIN_WORDS = 80; // only check texts long enough to matter

// â”€â”€ Daily per-student rate-limit check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns the number of AI-evaluated submissions a student has had today
 * (where the submission was processed by the AI batch â€” not just submitted).
 * "Today" = submissions where evaluated_at is >= start of current UTC day.
 */
async function getStudentAiChecksToday(studentId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabaseAdmin
    .from('homework_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', studentId)
    .gte('evaluated_at', startOfDay.toISOString())
    .not('evaluated_at', 'is', null);

  if (error) {
    console.warn('[homeworkEval] Could not check student daily limit:', error.message);
    return 0; // fail open â€” don't block on DB errors
  }
  return count ?? 0;
}

// â”€â”€ Cost logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Increment the daily cost log entry for a school.
 * Uses an UPSERT on (school_id, date) so the record is created if missing.
 */
async function incrementCostLog(
  schoolId: string,
  textCalls: number,
  visionCalls: number,
  cacheHits: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const additionalCost =
    textCalls * COST_PER_TEXT_CALL_INR +
    visionCalls * COST_PER_VISION_CALL_INR;

  // Try to insert first (common path when no record exists for today)
  const { error: insertErr } = await supabaseAdmin
    .from('ai_cost_log')
    .insert({
      school_id: schoolId,
      date: today,
      gemini_calls_text: textCalls,
      gemini_calls_vision: visionCalls,
      cache_hits: cacheHits,
      estimated_cost_inr: additionalCost,
      updated_at: new Date().toISOString(),
    });

  if (!insertErr) return; // inserted successfully

  // Row already exists â€” increment existing counters
  // Supabase JS doesn't support `col = col + N` natively, so we fetch + update.
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('ai_cost_log')
    .select('gemini_calls_text, gemini_calls_vision, cache_hits, estimated_cost_inr')
    .eq('school_id', schoolId)
    .eq('date', today)
    .maybeSingle();

  if (fetchErr || !existing) {
    console.warn('[homeworkEval] Could not fetch ai_cost_log for update:', fetchErr?.message);
    return;
  }

  const row = existing as {
    gemini_calls_text: number;
    gemini_calls_vision: number;
    cache_hits: number;
    estimated_cost_inr: number;
  };

  await supabaseAdmin
    .from('ai_cost_log')
    .update({
      gemini_calls_text: row.gemini_calls_text + textCalls,
      gemini_calls_vision: row.gemini_calls_vision + visionCalls,
      cache_hits: row.cache_hits + cacheHits,
      estimated_cost_inr: Number(row.estimated_cost_inr) + additionalCost,
      updated_at: new Date().toISOString(),
    })
    .eq('school_id', schoolId)
    .eq('date', today);
}

// â”€â”€ Hash helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * MD5 of (question + reference_answer) â€” identifies the question side.
 * The reference_answer may be null (teacher didn't provide one).
 */
export function buildQuestionHash(question: string, referenceAnswer: string | null): string {
  return crypto
    .createHash('md5')
    .update((question + (referenceAnswer ?? '')).toLowerCase().trim())
    .digest('hex');
}

/**
 * MD5 of the normalised submission text â€” identifies the answer side.
 * Lowercase + collapse whitespace to catch trivial reformatting.
 */
export function buildAnswerHash(text: string): string {
  return crypto
    .createHash('md5')
    .update(text.toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

// â”€â”€ Cache helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Look up the evaluation cache.
 * Returns cached result + feedback, or null on cache miss.
 */
async function getCachedEval(
  questionHash: string,
  answerHash: string
): Promise<{ cached_result: string; cached_feedback: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('homework_evaluation_cache')
    .select('cached_result, cached_feedback')
    .eq('question_hash', questionHash)
    .eq('answer_hash', answerHash)
    .maybeSingle();

  if (error || !data) return null;
  return data as { cached_result: string; cached_feedback: string };
}

/**
 * Insert or update the cache entry, bumping hit_count on collision.
 */
async function upsertEvalCache(
  questionHash: string,
  answerHash: string,
  result: string,
  feedback: string
): Promise<void> {
  // Try insert first
  const { error: insertErr } = await supabaseAdmin
    .from('homework_evaluation_cache')
    .insert({
      question_hash: questionHash,
      answer_hash: answerHash,
      cached_result: result,
      cached_feedback: feedback,
      hit_count: 1,
    });

  if (insertErr) {
    // Row already exists â€” bump hit_count
    await supabaseAdmin
      .from('homework_evaluation_cache')
      .update({
        hit_count: supabaseAdmin.rpc('increment_hit_count' as never) as unknown as number,
      })
      .eq('question_hash', questionHash)
      .eq('answer_hash', answerHash);

    // increment_hit_count may not exist; silently ignore errors â€” hit_count is non-critical
    try {
      await supabaseAdmin.rpc('increment_homework_cache_hit' as never, {
        p_question_hash: questionHash,
        p_answer_hash: answerHash,
      });
    } catch {
      // RPC may not exist â€” that's fine
    }
  }
}

/** Simpler upsert that uses a raw UPDATE for hit_count increment. */
async function recordCacheHit(questionHash: string, answerHash: string): Promise<void> {
  // Use raw update â€” Supabase JS client doesn't support col = col + 1 natively
  await supabaseAdmin
    .from('homework_evaluation_cache')
    .update({ hit_count: 999 }) // placeholder; replaced by DB trigger/RPC in prod
    .eq('question_hash', questionHash)
    .eq('answer_hash', answerHash);

  // Best-effort: update via raw SQL increment is not possible without RPC.
  // We'll just track that the cache was used via the evaluated_at timestamp.
}

// â”€â”€ Numerical evaluation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const NUMERIC_TOLERANCE = 0.01;

/**
 * Returns true if `text` looks like a pure number (possibly with units suffix
 * like "cm", "kg", "m/s" â€” we extract the leading numeric part).
 */
function extractNumber(text: string): number | null {
  const match = text.trim().match(/^-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return isNaN(n) ? null : n;
}

function evaluateNumerical(submissionText: string, referenceAnswer: string): EvalResult {
  const studentNum = extractNumber(submissionText.trim());
  const refNum = extractNumber(referenceAnswer.trim());

  if (studentNum === null || refNum === null) {
    // Can't parse â€” fall back to string comparison
    const match = submissionText.trim().toLowerCase() === referenceAnswer.trim().toLowerCase();
    return {
      result: match ? 'correct' : 'incorrect',
      confidence: 1.0,
      feedback: match ? 'Correct answer.' : `Expected: ${referenceAnswer.trim()}`,
    };
  }

  const diff = Math.abs(studentNum - refNum);
  const correct = diff <= NUMERIC_TOLERANCE;

  return {
    result: correct ? 'correct' : 'incorrect',
    confidence: 1.0,
    feedback: correct
      ? 'Correct answer.'
      : `Expected: ${refNum}. Got: ${studentNum}.`,
  };
}

// â”€â”€ Gemini helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Parse the JSON result from Gemini, stripping any markdown fences.
 * Returns null if parsing fails.
 */
function parseGeminiJson(raw: string): EvalResult | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const rawResult = parsed.result as string;
    const confidence = Number(parsed.confidence ?? 0);
    const feedback = String(parsed.feedback ?? '');

    if (!['correct', 'incorrect', 'partial', 'unclear'].includes(rawResult)) return null;
    if (isNaN(confidence) || confidence < 0 || confidence > 1) return null;

    return {
      result: rawResult as EvalResult['result'],
      confidence: Math.min(1, Math.max(0, confidence)),
      feedback: feedback.slice(0, 500), // cap feedback length
    };
  } catch {
    return null;
  }
}

// â”€â”€ Typed theory evaluation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function evaluateTypedAnswer(
  className: string,
  subjectName: string,
  question: string,
  referenceAnswer: string | null,
  submissionText: string,
  minWordCount: number | null
): Promise<EvalResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { result: 'partial', confidence: 0.0, feedback: 'AI not configured. Please check manually.' };

  const refNote = referenceAnswer?.trim()
    ? referenceAnswer.trim()
    : 'Not provided â€” use general subject knowledge';

  const wordCountNote = minWordCount
    ? `Minimum word requirement: ${minWordCount} words`
    : 'No minimum word count set';

  const prompt = `You are evaluating a Class ${className} student's homework answer for ${subjectName}.

Question: ${question}
Teacher's reference/expected answer: ${refNote}
${wordCountNote}
Student's answer: ${submissionText}

Evaluate:
1. Is the core concept/answer correct?
2. Does it meet the minimum requirements (word count, key points)?
3. Brief constructive feedback (max 30 words)

IMPORTANT: Do not provide the correct answer or solution method in your feedback. Only state whether the submitted answer is correct/incorrect/partial and give feedback on quality/completeness -- never reveal what the right answer should have been.

Return ONLY valid JSON:
{"result": "correct" or "incorrect" or "partial", "confidence": 0.0 to 1.0, "feedback": "string"}`;

  const evalResponseSchema = {
    type: 'object' as const,
    properties: {
      result:     { type: 'string' as const, enum: ['correct', 'incorrect', 'partial'] },
      confidence: { type: 'number' as const },
      feedback:   { type: 'string' as const },
    },
    required: ['result', 'confidence', 'feedback'],
  };

  try {
    const { text } = await geminiRawGenerate({
      apiKey,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      parts: [{ text: prompt }],
      responseSchema: evalResponseSchema as Record<string, unknown>,
      disableThinking: true,
    });
    const parsed = parseGeminiJson(text.trim());
    if (!parsed) {
      return { result: 'partial', confidence: 0.5, feedback: 'AI could not evaluate. Please check manually.' };
    }
    return parsed;
  } catch (err) {
    console.error('[homeworkEval] Typed eval error:', err instanceof Error ? err.message : err);
    return { result: 'partial', confidence: 0.0, feedback: 'Evaluation failed. Please check manually.' };
  }
}

// â”€â”€ Photo evaluation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function evaluatePhotoAnswer(
  className: string,
  subjectName: string,
  question: string,
  referenceAnswer: string | null,
  imageUrls: string[],
  requiresDiagram: boolean,
  minWordCount: number | null,
  referenceFileUrl: string | null = null
): Promise<EvalResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { result: 'unclear', confidence: 0.0, feedback: 'AI not configured. Please check manually.' };

  const refNote = referenceAnswer?.trim()
    ? `Teacher's reference/expected method or answer: ${referenceAnswer.trim()}`
    : '';

  const reqParts: string[] = [];
  if (requiresDiagram) reqParts.push('must include a diagram');
  if (minWordCount) reqParts.push(`minimum ${minWordCount} words`);
  const reqNote = reqParts.length > 0 ? `Requirements: ${reqParts.join(', ')}` : '';

  const hasReferenceImage = !!referenceFileUrl;

  const promptText = `This is a photo of a Class ${className} student's handwritten homework for ${subjectName}.

Question: ${question}
${refNote}
${reqNote}
${hasReferenceImage ? 'Note: The teacher has also provided a reference solution image (shown first below). Compare the student\'s work against it.' : ''}

Analyze the image and evaluate:
1. Is the work shown correct based on the reference?
2. Are the stated requirements met (diagram present if required, sufficient length if specified)?
3. If the image is unclear/illegible, say so
4. Brief feedback (max 30 words)

IMPORTANT: Do not provide the correct answer or solution method in your feedback. Only state whether the submitted answer is correct/incorrect/partial and give feedback on quality/completeness -- never reveal what the right answer should have been.

Return ONLY valid JSON:
{"result": "correct" or "incorrect" or "partial" or "unclear", "confidence": 0.0 to 1.0, "feedback": "string"}`;

  // Build parts for the raw REST call (vision)
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  // Optionally prepend teacher's reference image first
  if (referenceFileUrl) {
    try {
      const resp = await fetch(referenceFileUrl);
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
        parts.push({ inlineData: { mimeType: contentType, data: base64 } });
        parts.push({ text: '[Above image: Teacher reference solution]' });
      }
    } catch (err) {
      console.warn('[homeworkEval] Could not fetch reference image:', referenceFileUrl, err instanceof Error ? err.message : err);
    }
  }

  if (parts.length > 0) {
    parts.push({ text: '[Below: Student submission]' });
  }
  for (const url of imageUrls.slice(0, 3)) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
      parts.push({ inlineData: { mimeType: contentType, data: base64 } });
    } catch (err) {
      console.warn('[homeworkEval] Could not fetch image:', url, err instanceof Error ? err.message : err);
    }
  }

  if (parts.filter(p => p.inlineData).length === 0) {
    return { result: 'unclear', confidence: 0.0, feedback: 'Could not load submission images for evaluation.' };
  }

  parts.push({ text: promptText });

  // Vision eval uses raw REST â€” same pattern as text eval, thinkingBudget:0 guaranteed
  try {
    const { text } = await geminiRawGenerate({
      apiKey,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      parts,
      disableThinking: true,
    });
    const parsed = parseGeminiJson(text.trim());
    if (!parsed) {
      return { result: 'unclear', confidence: 0.5, feedback: 'AI could not evaluate image. Teacher review needed.' };
    }
    return parsed;
  } catch (err) {
    console.error('[homeworkEval] Photo eval error:', err instanceof Error ? err.message : err);
    return { result: 'unclear', confidence: 0.0, feedback: 'Image evaluation failed. Please check manually.' };
  }
}

// â”€â”€ Suspicious-text detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Heuristic check: is this typed answer suspiciously well-written for the
 * student's class level?
 *
 * Uses average words-per-sentence as a simple proxy for text complexity.
 * If avg WPS exceeds the class-level threshold, flag it.
 * Only applied when teacher has opted in via `check_suspicious = true`.
 */
export function isSuspiciouslyPerfect(text: string, className: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < SUSPICIOUS_MIN_WORDS) return false; // too short to be meaningful

  // Split into sentences
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return false;

  const avgWPS = words.length / sentences.length;

  // Extract numeric class level (e.g. "Class 5" â†’ "5", "5th" â†’ "5")
  const classMatch = className.replace(/[^0-9]/g, '');
  const threshold = SUSPICIOUS_WPS_BY_CLASS[classMatch] ?? DEFAULT_SUSPICIOUS_WPS;

  return avgWPS > threshold;
}

// â”€â”€ Update helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function updateSubmission(
  submissionId: string,
  fields: {
    status: string;
    ai_result: string;
    ai_confidence: number;
    ai_feedback: string;
    flagged_reason?: string | null;
    evaluated_at: string;
  }
): Promise<void> {
  // DB constraint allows: 'correct' | 'incorrect' | 'partial' | 'needs_review'
  // Map 'unclear' (returned by Gemini) to 'needs_review' to satisfy the constraint
  const safeFields = {
    ...fields,
    ai_result: fields.ai_result === 'unclear' ? 'needs_review' : fields.ai_result,
  };

  const { error } = await supabaseAdmin
    .from('homework_submissions')
    .update(safeFields)
    .eq('id', submissionId);

  if (error) {
    console.error(`[homeworkEval] Failed to update submission ${submissionId}:`, error.message);
  }
}

// â”€â”€ Main batch evaluator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Process all pending submissions in one batch run.
 * Called by the nightly cron endpoint.
 *
 * @returns Stats object describing what was processed.
 */
export async function runHomeworkBatchEval(): Promise<BatchStats> {
  const stats: BatchStats = {
    total: 0,
    cache_hits: 0,
    numerical: 0,
    typed_ai: 0,
    photo_ai: 0,
    checked: 0,
    flagged: 0,
    errors: 0,
    overflow_skipped: 0,
  };

  const now = new Date().toISOString();

  // â”€â”€ Step 0a: Recover stale 'processing' submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // If the server crashed or was restarted mid-batch, some submissions may be
  // stuck in 'processing' indefinitely because the batch never set them to a
  // final state. Reset any submission that has been in 'processing' for more
  // than 30 minutes back to 'submitted' so this run can pick them up.
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { error: recoverErr, count: recoveredCount } = await supabaseAdmin
    .from('homework_submissions')
    .update({ status: 'submitted' })
    .eq('status', 'processing')
    .lt('updated_at', staleThreshold);

  if (recoverErr) {
    console.warn('[homeworkEval] Could not recover stale processing submissions:', recoverErr.message);
  } else if (recoveredCount && recoveredCount > 0) {
    console.log(`[homeworkEval] Recovered ${recoveredCount} stale 'processing' submissions back to 'submitted'`);
  }

  // â”€â”€ Step 0b: Reset overflow flags from previous days â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Submissions marked queued_overflow=true should be retried today.
  // Clear the flag for all overflow submissions from BEFORE today (UTC).
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startOfTodayIso = startOfToday.toISOString();

  const { error: clearErr } = await supabaseAdmin
    .from('homework_submissions')
    .update({ queued_overflow: false })
    .eq('status', 'submitted')
    .eq('queued_overflow', true)
    .lt('submitted_at', startOfTodayIso);

  if (clearErr) {
    console.warn('[homeworkEval] Could not clear overflow flags:', clearErr.message);
  }

  // â”€â”€ Step 1: Fetch all pending submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Join with homework to get the question/reference data.
  // Skip submissions that are already flagged_for_review (teacher handles those).
  const { data: submissions, error: fetchErr } = await supabaseAdmin
    .from('homework_submissions')
    .select(`
      id,
      student_id,
      homework_id,
      submission_text,
      submission_image_urls,
      status,
      queued_overflow,
      homework:homework_id (
        id,
        title,
        class_name,
        section,
        school_id,
        subject_type,
        reference_answer,
        reference_file_url,
        min_word_count,
        requires_diagram,
        check_suspicious,
        ai_check_enabled,
        subjects ( name )
      )
    `)
    .eq('status', 'submitted')
    .eq('queued_overflow', false);

  if (fetchErr) {
    console.error('[homeworkEval] Failed to fetch submissions:', fetchErr.message);
    return stats;
  }

  const rows = (submissions ?? []) as unknown as Array<SubmissionRow & { homework: HomeworkRow & { ai_check_enabled: boolean } }>;

  // Filter: only process homework that has ai_check_enabled = true
  const eligible = rows.filter((r) => r.homework?.ai_check_enabled === true);
  stats.total = eligible.length;

  console.log(`[homeworkEval] Batch started â€” ${eligible.length} eligible submissions`);

  // Cost accumulators per school (school_id â†’ { text, vision, cache })
  const schoolCosts = new Map<string, { text: number; vision: number; cache: number }>();

  const addCost = (schoolId: string, type: 'text' | 'vision' | 'cache') => {
    const entry = schoolCosts.get(schoolId) ?? { text: 0, vision: 0, cache: 0 };
    entry[type]++;
    schoolCosts.set(schoolId, entry);
  };

  // â”€â”€ Per-school spend cap + feature flag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Loaded once per school on first access, cached in-memory for the batch run.
  interface SchoolCapEntry {
    aiEnabled: boolean;
    cap: number | null;    // null = unlimited
    spentToday: number;    // INR already logged in ai_cost_log for today
  }
  const schoolCapCache = new Map<string, SchoolCapEntry>();

  async function loadSchoolCap(schoolId: string): Promise<SchoolCapEntry> {
    if (schoolCapCache.has(schoolId)) return schoolCapCache.get(schoolId)!;

    const { data: school } = await supabaseAdmin
      .from('schools')
      .select('ai_homework_enabled, daily_ai_spend_cap_inr')
      .eq('id', schoolId)
      .maybeSingle();

    const row = school as { ai_homework_enabled: boolean; daily_ai_spend_cap_inr: number | null } | null;
    // If the column doesn't exist yet (migration not run), default to enabled/unlimited
    const aiEnabled = row?.ai_homework_enabled ?? true;
    const cap = row?.daily_ai_spend_cap_inr ?? null;

    const today = new Date().toISOString().slice(0, 10);
    const { data: costRow } = await supabaseAdmin
      .from('ai_cost_log')
      .select('estimated_cost_inr')
      .eq('school_id', schoolId)
      .eq('date', today)
      .maybeSingle();

    const spentToday = Number(
      (costRow as { estimated_cost_inr: number } | null)?.estimated_cost_inr ?? 0
    );

    const entry: SchoolCapEntry = { aiEnabled, cap, spentToday };
    schoolCapCache.set(schoolId, entry);
    return entry;
  }

  /**
   * Returns true if this school has AI disabled OR has hit its daily spend cap.
   * Cache hits and numerical evals (zero cost) are allowed even when over cap.
   */
  async function isSchoolAiBlocked(schoolId: string): Promise<boolean> {
    const entry = await loadSchoolCap(schoolId);
    if (!entry.aiEnabled) return true;
    if (entry.cap === null) return false;

    // Add spend accumulated so far in this batch run (not yet flushed to DB)
    const batchCosts = schoolCosts.get(schoolId);
    const batchSpend = batchCosts
      ? batchCosts.text * COST_PER_TEXT_CALL_INR + batchCosts.vision * COST_PER_VISION_CALL_INR
      : 0;

    return (entry.spentToday + batchSpend) >= entry.cap;
  }

  // Track which student submissions changed to 'checked' or 'flagged_for_review'
  // so we can send notifications after the loop
  const checkedStudentIds: string[] = [];
  const flaggedByHomework = new Map<string, { school_id: string; flagged_count: number }>();

  // â”€â”€ Step 2: Process each submission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const row of eligible) {
    const hw = row.homework;
    if (!hw) { stats.errors++; continue; }

    // â”€â”€ Daily per-student rate limit check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Max 5 AI-checked submissions per student per day across all subjects.
    // Overflow submissions are re-queued for the next day's batch.
    const checksToday = await getStudentAiChecksToday(row.student_id);
    if (checksToday >= MAX_AI_CHECKS_PER_STUDENT_PER_DAY) {
      // Mark as overflow â€” will be retried tomorrow
      await supabaseAdmin
        .from('homework_submissions')
        .update({ queued_overflow: true })
        .eq('id', row.id);
      stats.overflow_skipped++;
      console.log(
        `[homeworkEval] Overflow: student ${row.student_id} has ${checksToday} checks today (limit ${MAX_AI_CHECKS_PER_STUDENT_PER_DAY}), submission ${row.id} queued for tomorrow`
      );
      continue;
    }

    // â”€â”€ School AI feature flag + daily spend cap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Skip expensive AI calls if the school has disabled AI homework or has
    // reached its daily spend cap. Free paths (cache hits, numerical) are
    // unaffected â€” they run regardless. We check this AFTER the per-student
    // rate limit so overflow accounting still happens correctly.
    const schoolBlocked = await isSchoolAiBlocked(hw.school_id);

    const question = hw.title; // homework title is the question prompt
    const subjectName = (hw.subjects as unknown as { name: string } | null)?.name ?? 'Unknown';
    const evalAt = new Date().toISOString();

    try {
      // Mark as 'processing' first to avoid double-processing on re-runs.
      // updated_at is set here so the stale-recovery step at the top of
      // this function can detect submissions that got stuck in this state.
      await supabaseAdmin
        .from('homework_submissions')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', row.id);

      const isPhotoOnly =
        (!row.submission_text || !row.submission_text.trim()) &&
        row.submission_image_urls &&
        row.submission_image_urls.length > 0;

      const hasText = !!(row.submission_text && row.submission_text.trim());
      const hasPhotos = !!(row.submission_image_urls && row.submission_image_urls.length > 0);

      let evalResult: EvalResult;
      let usedCache = false;
      let isNumerical = false;

      // â”€â”€ Photo-only submissions â†’ skip cache, go straight to vision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (isPhotoOnly) {
        // If school is blocked (feature off or cap reached), skip vision eval
        // and revert to submitted so it can be retried if the cap resets.
        if (schoolBlocked) {
          await supabaseAdmin
            .from('homework_submissions')
            .update({ status: 'submitted' })
            .eq('id', row.id);
          console.log(`[homeworkEval] School ${hw.school_id} AI blocked â€” skipping vision eval for ${row.id}`);
          stats.overflow_skipped++;
          continue;
        }
        stats.photo_ai++;
        evalResult = await evaluatePhotoAnswer(
          hw.class_name,
          subjectName,
          question,
          hw.reference_answer,
          row.submission_image_urls!,
          hw.requires_diagram,
          hw.min_word_count,
          hw.reference_file_url
        );
        addCost(hw.school_id, 'vision');
        // Photos are never cached
      } else if (hasText) {
        const text = row.submission_text!.trim();

        // â”€â”€ Numerical shortcut (zero cost â€” always runs even when blocked) â”€â”€â”€â”€â”€
        if (
          hw.subject_type === 'numerical' &&
          hw.reference_answer?.trim() &&
          extractNumber(text) !== null
        ) {
          isNumerical = true;
          stats.numerical++;
          evalResult = evaluateNumerical(text, hw.reference_answer!);
        } else {
          // â”€â”€ Cache check (zero cost â€” always runs even when blocked) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          const qHash = buildQuestionHash(question, hw.reference_answer);
          const aHash = buildAnswerHash(text);

          const cached = await getCachedEval(qHash, aHash);
          if (cached) {
            stats.cache_hits++;
            usedCache = true;
            evalResult = {
              result: cached.cached_result as EvalResult['result'],
              confidence: 1.0, // cache hits treated as high-confidence
              feedback: cached.cached_feedback,
            };
            // Bump hit count (best-effort)
            await recordCacheHit(qHash, aHash);
            addCost(hw.school_id, 'cache');
          } else {
            // â”€â”€ AI evaluation â€” only if school is not blocked â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            if (schoolBlocked) {
              await supabaseAdmin
                .from('homework_submissions')
                .update({ status: 'submitted' })
                .eq('id', row.id);
              console.log(`[homeworkEval] School ${hw.school_id} AI blocked â€” skipping text eval for ${row.id}`);
              stats.overflow_skipped++;
              continue;
            }
            stats.typed_ai++;
            evalResult = await evaluateTypedAnswer(
              hw.class_name,
              subjectName,
              question,
              hw.reference_answer,
              text,
              hw.min_word_count
            );
            addCost(hw.school_id, 'text');

            // If photo also attached, re-evaluate combined (photo takes priority)
            // For mixed submissions we use the typed text result since text is
            // usually the primary content; photo is supplementary.

            // Cache successful typed evaluations
            if (evalResult.confidence >= CONFIDENCE_THRESHOLD) {
              await upsertEvalCache(qHash, aHash, evalResult.result, evalResult.feedback);
            }
          }
        }

        // â”€â”€ Suspicious-text check (typed theory only, opt-in) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (
          !isNumerical &&
          !usedCache &&
          hasText &&
          hw.check_suspicious &&
          isSuspiciouslyPerfect(row.submission_text!.trim(), hw.class_name)
        ) {
          // Override to flagged regardless of AI result
          await updateSubmission(row.id, {
            status: 'flagged_for_review',
            ai_result: evalResult!.result,
            ai_confidence: evalResult!.confidence,
            ai_feedback: evalResult!.feedback,
            flagged_reason: 'suspicious_perfect',
            evaluated_at: evalAt,
          });
          stats.flagged++;

          // Track for teacher notification
          const hwId = hw.id;
          const existing = flaggedByHomework.get(hwId);
          if (existing) {
            existing.flagged_count++;
          } else {
            flaggedByHomework.set(hwId, { school_id: hw.school_id, flagged_count: 1 });
          }
          continue;
        }
      } else {
        // Neither text nor photos â€” skip
        await supabaseAdmin
          .from('homework_submissions')
          .update({ status: 'submitted', evaluated_at: evalAt }) // revert processing
          .eq('id', row.id);
        stats.errors++;
        continue;
      }

      // â”€â”€ Confidence threshold routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const finalStatus =
        isNumerical || usedCache
          ? 'checked'
          : evalResult!.result === 'unclear' || evalResult!.confidence < CONFIDENCE_THRESHOLD
            ? 'flagged_for_review'
            : 'checked';

      // Photo 'unclear' â†’ always flagged
      const photoUnclear = isPhotoOnly && evalResult!.result === 'unclear';
      const photLowConf = isPhotoOnly && evalResult!.confidence < CONFIDENCE_THRESHOLD;
      const routedStatus =
        photoUnclear || photLowConf ? 'flagged_for_review' : finalStatus;

      const flaggedReason: string | null =
        routedStatus === 'flagged_for_review'
          ? photoUnclear
            ? 'low_confidence'
            : evalResult!.result === 'unclear'
              ? 'low_confidence'
              : evalResult!.confidence < CONFIDENCE_THRESHOLD
                ? 'low_confidence'
                : null
          : null;

      await updateSubmission(row.id, {
        status: routedStatus,
        ai_result: evalResult!.result,
        ai_confidence: evalResult!.confidence,
        ai_feedback: evalResult!.feedback,
        flagged_reason: flaggedReason,
        evaluated_at: evalAt,
      });

      if (routedStatus === 'checked') {
        stats.checked++;
        checkedStudentIds.push(row.student_id);
      } else {
        stats.flagged++;
        const hwId = hw.id;
        const existing = flaggedByHomework.get(hwId);
        if (existing) {
          existing.flagged_count++;
        } else {
          flaggedByHomework.set(hwId, { school_id: hw.school_id, flagged_count: 1 });
        }
      }
    } catch (err) {
      console.error(`[homeworkEval] Error processing submission ${row.id}:`, err instanceof Error ? err.message : err);
      stats.errors++;
      // Revert processing status so it can be retried
      try {
        await supabaseAdmin
          .from('homework_submissions')
          .update({ status: 'submitted' })
          .eq('id', row.id);
      } catch { /* best-effort revert */ }
    }
  }

  // â”€â”€ Step 3: Send FCM notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await sendCheckedNotifications(checkedStudentIds);
  await sendFlaggedNotificationsToTeachers(flaggedByHomework, now);

  // â”€â”€ Step 4: Flush cost logs to database (per school) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const [schoolId, costs] of schoolCosts.entries()) {
    try {
      await incrementCostLog(schoolId, costs.text, costs.vision, costs.cache);
    } catch (err) {
      console.error('[homeworkEval] Failed to log costs for school', schoolId, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `[homeworkEval] Batch complete â€” ` +
    `total: ${stats.total}, cache: ${stats.cache_hits}, numerical: ${stats.numerical}, ` +
    `typed_ai: ${stats.typed_ai}, photo_ai: ${stats.photo_ai}, ` +
    `checked: ${stats.checked}, flagged: ${stats.flagged}, errors: ${stats.errors}, ` +
    `overflow_skipped: ${stats.overflow_skipped}`
  );

  return stats;
}

// â”€â”€ Notification helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Send "Your homework has been checked!" notification to all students (and
 * their parents) whose submission was moved to 'checked'.
 */
async function sendCheckedNotifications(studentIds: string[]): Promise<void> {
  if (studentIds.length === 0) return;

  const { sendPushMulticast, getTokensForStudents } = await import('./fcmService');

  // Deduplicate student IDs
  const uniqueIds = Array.from(new Set(studentIds));

  try {
    // Fetch student FCM tokens
    const tokens = await getTokensForStudents(uniqueIds);
    if (tokens.length > 0) {
      await sendPushMulticast(
        tokens,
        'âœ… Homework Checked!',
        'Your homework has been checked! Tap to see your results.',
        { type: 'homework_checked' }
      );
    }

    // Also insert in-app notifications
    const notifRows = uniqueIds.map((studentId) => ({
      title: 'âœ… Homework Checked!',
      message: 'Your homework has been checked! Tap to see your results.',
      type: 'announcement',
      recipient_id: studentId,
      sender_id: null,
      is_read: false,
      created_at: new Date().toISOString(),
    }));

    // Batch insert in chunks of 100
    for (let i = 0; i < notifRows.length; i += 100) {
      try {
        await supabaseAdmin
          .from('notifications')
          .insert(notifRows.slice(i, i + 100));
      } catch (err) {
        console.error('[homeworkEval] Notification insert error:', err instanceof Error ? err.message : err);
      }
    }

    // Notify parents too
    const { data: students } = await supabaseAdmin
      .from('students')
      .select('id, parent_id, full_name')
      .in('id', uniqueIds)
      .not('parent_id', 'is', null);

    const parentIds = (students ?? [])
      .map((s: Record<string, unknown>) => s.parent_id as string)
      .filter(Boolean);

    if (parentIds.length > 0) {
      const { getTokensForUsers } = await import('./fcmService');
      const parentTokens = await getTokensForUsers(parentIds);
      if (parentTokens.length > 0) {
        await sendPushMulticast(
          parentTokens,
          'âœ… Homework Results Ready!',
          "Your child's homework has been checked! Tap to see the results.",
          { type: 'homework_checked' }
        );
      }
    }

    console.log(`[homeworkEval] Checked notifications sent to ${uniqueIds.length} students`);
  } catch (err) {
    console.error('[homeworkEval] Failed to send checked notifications:', err instanceof Error ? err.message : err);
  }
}

/**
 * For each homework that has flagged submissions, find the teacher (created_by)
 * and send them: "X homework submissions need your review."
 */
async function sendFlaggedNotificationsToTeachers(
  flaggedByHomework: Map<string, { school_id: string; flagged_count: number }>,
  _evaluatedAt: string
): Promise<void> {
  if (flaggedByHomework.size === 0) return;

  const { sendPushNotification } = await import('./fcmService');

  const homeworkIds = Array.from(flaggedByHomework.keys());

  try {
    const { data: homeworkList } = await supabaseAdmin
      .from('homework')
      .select('id, title, created_by')
      .in('id', homeworkIds);

    for (const hw of homeworkList ?? []) {
      const hwRow = hw as { id: string; title: string; created_by: string };
      const flaggedInfo = flaggedByHomework.get(hwRow.id);
      if (!flaggedInfo) continue;

      const { flagged_count } = flaggedInfo;
      const plural = flagged_count === 1 ? 'submission' : 'submissions';

      // FCM push to teacher
      try {
        await sendPushNotification(
          hwRow.created_by,
          'ðŸ“‹ Review Needed',
          `${flagged_count} homework ${plural} for "${hwRow.title}" need your review.`,
          { type: 'homework_review_needed', homework_id: hwRow.id },
          'user'
        );
      } catch (err) {
        console.error('[homeworkEval] Teacher FCM error:', err instanceof Error ? err.message : err);
      }

      // In-app notification
      try {
        await supabaseAdmin
          .from('notifications')
          .insert({
            title: 'ðŸ“‹ Review Needed',
            message: `${flagged_count} homework ${plural} for "${hwRow.title}" need your review.`,
            type: 'announcement',
            recipient_id: hwRow.created_by,
            sender_id: null,
            is_read: false,
            created_at: new Date().toISOString(),
          });
      } catch (err) {
        console.error('[homeworkEval] Teacher notification insert error:', err instanceof Error ? err.message : err);
      }
    }

    console.log(`[homeworkEval] Flagged notifications sent for ${homeworkIds.length} homework items`);
  } catch (err) {
    console.error('[homeworkEval] Failed to send flagged notifications:', err instanceof Error ? err.message : err);
  }
}
