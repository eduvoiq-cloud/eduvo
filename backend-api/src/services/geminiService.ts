import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import mammoth from "mammoth";
import crypto from "crypto";
import { supabase } from "../config/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCQQuestion {
  question: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "a" | "b" | "c" | "d";
  marks: number;
}

export interface TheoryQuestion {
  question: string;
  expected_answer: string;
  marks: number;
}

export interface GeneratedContent {
  mcq_questions: MCQQuestion[];
  theory_questions: TheoryQuestion[];
}

/**
 * What gets stored in the extraction cache.
 * PDFs are stored as base64 for direct Gemini vision.
 * DOCX/TXT are stored as plain text.
 */
export interface ExtractionResult {
  type: "pdf_base64" | "text";
  /** base64 string for PDFs, plain text for docx/txt */
  data: string;
  /** character count for display (base64 length for PDFs) */
  total_chars: number;
}

export interface GenerateQuestionsParams {
  extraction: ExtractionResult;
  subject: string;
  class_level: string;
  difficulty: "easy" | "medium" | "hard";
  mcq_count: number;
  theory_count: number;
  teacher_id: string;
  school_id: string;
}

export interface SaveUsageParams {
  user_id: string;
  school_id: string;
  feature: string;
  tokens_used: number;
  prompt_hash: string;
  cached_result: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 50_000;
const MAX_DAILY_GENERATIONS = parseInt(
  process.env.AI_MAX_DAILY_GENERATIONS ?? "10",
  10
);

// ---------------------------------------------------------------------------
// 1. extractFromFile
// ---------------------------------------------------------------------------

/**
 * For PDFs: returns base64-encoded file data for direct Gemini vision.
 * For DOCX/TXT: extracts plain text as before.
 * This handles both scanned and digital PDFs.
 */
export async function extractFromFile(
  file: Express.Multer.File
): Promise<ExtractionResult> {
  const mime = file.mimetype.toLowerCase();
  const originalName = (file.originalname ?? "").toLowerCase();

  // ── PDF: send as base64 directly to Gemini vision ──────────────────────────
  if (mime === "application/pdf" || originalName.endsWith(".pdf")) {
    const base64 = file.buffer.toString("base64");
    console.log(`[extractFromFile] PDF stored as base64, size: ${file.buffer.length} bytes`);
    return {
      type: "pdf_base64",
      data: base64,
      total_chars: base64.length,
    };
  }

  // ── DOCX: extract text with mammoth ────────────────────────────────────────
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    originalName.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    const cleaned = cleanText(result.value);
    console.log(`[extractFromFile] DOCX text chars: ${cleaned.length}`);
    return {
      type: "text",
      data: cleaned,
      total_chars: cleaned.length,
    };
  }

  // ── TXT: read as utf-8 ─────────────────────────────────────────────────────
  if (mime === "text/plain" || originalName.endsWith(".txt")) {
    const cleaned = cleanText(file.buffer.toString("utf-8"));
    console.log(`[extractFromFile] TXT chars: ${cleaned.length}`);
    return {
      type: "text",
      data: cleaned,
      total_chars: cleaned.length,
    };
  }

  throw new Error(
    `Unsupported file type: ${file.mimetype}. Please upload a PDF, DOCX, or TXT file.`
  );
}

/** Normalise whitespace and truncate plain text. */
function cleanText(raw: string): string {
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > MAX_TEXT_CHARS
    ? cleaned.slice(0, MAX_TEXT_CHARS)
    : cleaned;
}

// ---------------------------------------------------------------------------
// 2. generateQuestions
// ---------------------------------------------------------------------------

/**
 * Calls Gemini to generate MCQ and theory questions.
 * For PDFs: sends the file as inlineData (vision) — works for scanned PDFs too.
 * For text: sends as a text prompt.
 */
export async function generateQuestions(
  params: GenerateQuestionsParams
): Promise<GeneratedContent> {
  const {
    extraction,
    subject,
    class_level,
    difficulty,
    mcq_count,
    theory_count,
    teacher_id,
    school_id,
  } = params;

  const t_gs0 = performance.now();
  console.log('[PERF:gemini] generateQuestions — entered');

  // Rate-limit check
  const allowed = await checkDailyLimit(teacher_id, school_id);
  if (!allowed) {
    throw new Error(
      `Daily AI generation limit of ${MAX_DAILY_GENERATIONS} reached. Please try again tomorrow.`
    );
  }

  // Build a deterministic hash for caching
  const promptHash = buildPromptHash(
    extraction.data,
    subject,
    class_level,
    difficulty,
    mcq_count,
    theory_count
  );

  const t_gs1_promptBuilt = performance.now();
  console.log(`[PERF:gemini] Prompt hash built (incl. daily-limit DB check): ${((t_gs1_promptBuilt - t_gs0) / 1000).toFixed(3)}s`);

  // Return cached result if fresh
  const cached = await getCachedResult(promptHash);
  const t_gs2_cacheChecked = performance.now();
  console.log(`[PERF:gemini] Cache DB lookup: ${((t_gs2_cacheChecked - t_gs1_promptBuilt) / 1000).toFixed(3)}s`);

  if (cached) {
    console.log('[PERF:gemini] Cache HIT — returning cached result');
    return JSON.parse(cached) as GeneratedContent;
  }

  // ── Build Gemini request ───────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const systemInstruction = [
    "You are an experienced teacher creating exam questions.",
    "Generate questions ONLY based on the provided content.",
    "Do NOT add information not present in the content.",
    "Do NOT hallucinate facts.",
    "Return ONLY valid JSON. No markdown, no explanation.",
  ].join("\n");

  const instructionText = `
Subject: ${subject}
Class: ${class_level}
Difficulty: ${difficulty}
Generate ${mcq_count} MCQ questions and ${theory_count} theory questions based on the content above.
Return this exact JSON structure:
{
  "mcq_questions": [
    {
      "question": "question text",
      "option_a": "option text",
      "option_b": "option text",
      "option_c": "option text",
      "option_d": "option text",
      "correct_option": "a",
      "marks": 1
    }
  ],
  "theory_questions": [
    {
      "question": "question text",
      "expected_answer": "brief answer guide for teacher",
      "marks": 5
    }
  ]
}`;

  // Build the parts array depending on content type
  let requestParts: Part[];

  if (extraction.type === "pdf_base64") {
    // Send PDF as inline vision data — Gemini reads it natively (scanned or digital)
    requestParts = [
      {
        inlineData: {
          mimeType: "application/pdf",
          data: extraction.data,
        },
      },
      { text: instructionText },
    ];
  } else {
    // Plain text content
    requestParts = [
      {
        text: `<content>\n${extraction.data}\n</content>\n${instructionText}`,
      },
    ];
  }

  const modelId = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const fallbackModelId = "gemini-2.0-flash";
  const modelsToTry = modelId === fallbackModelId ? [modelId] : [modelId, fallbackModelId];
  console.log(`[PERF:gemini] Using model: ${modelId}`);

  const genAI = new GoogleGenerativeAI(apiKey);

  let result: Awaited<ReturnType<ReturnType<typeof genAI.getGenerativeModel>['generateContent']>> | null = null;
  let tokensUsed = 0;
  let t_gs3_geminiCallStart = 0;
  let t_gs4_geminiCallDone = 0;

  for (const currentModelId of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: currentModelId, systemInstruction });
      t_gs3_geminiCallStart = performance.now();
      if (currentModelId !== modelId) {
        console.warn(`[PERF:gemini] Falling back to ${currentModelId}…`);
      }
      console.log(`[PERF:gemini] Calling Gemini API (model: ${currentModelId}, content-type: ${extraction.type})...`);
      result = await model.generateContent({ contents: [{ role: "user", parts: requestParts }] });
      t_gs4_geminiCallDone = performance.now();
      tokensUsed = result.response.usageMetadata?.totalTokenCount ?? 0;
      console.log(`[PERF:gemini] Gemini API responded: ${((t_gs4_geminiCallDone - t_gs3_geminiCallStart) / 1000).toFixed(3)}s | tokens used: ${tokensUsed}`);
      break; // success
    } catch (err) {
      const status = (err as Record<string, unknown>)?.status as number | undefined;
      if ((status === 503 || status === 429) && currentModelId !== fallbackModelId) {
        console.warn(`[geminiService] ${currentModelId} returned ${status}, retrying with ${fallbackModelId}…`);
        continue;
      }
      throw err; // non-retryable or already on fallback
    }
  }

  if (!result) {
    throw new Error("AI is currently overloaded. Please try again in a moment.");
  }

  const responseText = result.response.text().trim();

  // Parse JSON — strip accidental markdown fences
  let parsed: GeneratedContent;
  try {
    const jsonText = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(jsonText) as GeneratedContent;
  } catch {
    throw new Error("AI returned invalid format, please retry");
  }

  const t_gs5_dbSaveStart = performance.now();
  await saveUsageRecord({
    user_id: teacher_id,
    school_id,
    feature: "question_generation",
    tokens_used: tokensUsed,
    prompt_hash: promptHash,
    cached_result: JSON.stringify(parsed),
  });
  const t_gs6_dbSaveDone = performance.now();
  console.log(`[PERF:gemini] Usage record saved to DB: ${((t_gs6_dbSaveDone - t_gs5_dbSaveStart) / 1000).toFixed(3)}s`);

  console.log(`[PERF:gemini] ── generateQuestions internal breakdown ──────────`);
  console.log(`[PERF:gemini]   Daily-limit check + hash build: ${((t_gs1_promptBuilt - t_gs0) / 1000).toFixed(3)}s`);
  console.log(`[PERF:gemini]   Cache DB lookup:                ${((t_gs2_cacheChecked - t_gs1_promptBuilt) / 1000).toFixed(3)}s`);
  console.log(`[PERF:gemini]   Gemini API call (TTFB+stream):  ${((t_gs4_geminiCallDone - t_gs3_geminiCallStart) / 1000).toFixed(3)}s`);
  console.log(`[PERF:gemini]   DB save (usage record):         ${((t_gs6_dbSaveDone - t_gs5_dbSaveStart) / 1000).toFixed(3)}s`);
  console.log(`[PERF:gemini]   Total inside generateQuestions: ${((t_gs6_dbSaveDone - t_gs0) / 1000).toFixed(3)}s`);
  console.log(`[PERF:gemini] ─────────────────────────────────────────────────`);

  return parsed;
}

// ---------------------------------------------------------------------------
// 3. checkDailyLimit
// ---------------------------------------------------------------------------

export async function checkDailyLimit(
  user_id: string,
  school_id: string
): Promise<boolean> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from("ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .eq("school_id", school_id)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.error("[geminiService] checkDailyLimit error:", error.message);
    return true;
  }

  return (count ?? 0) < MAX_DAILY_GENERATIONS;
}

// ---------------------------------------------------------------------------
// 4. getCachedResult
// ---------------------------------------------------------------------------

export async function getCachedResult(
  prompt_hash: string
): Promise<string | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("ai_usage")
    .select("cached_result")
    .eq("prompt_hash", prompt_hash)
    .gte("created_at", cutoff)
    .not("cached_result", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[geminiService] getCachedResult error:", error.message);
    return null;
  }

  return data?.cached_result ?? null;
}

// ---------------------------------------------------------------------------
// 5. saveUsageRecord
// ---------------------------------------------------------------------------

export async function saveUsageRecord(params: SaveUsageParams): Promise<void> {
  const { error } = await supabase.from("ai_usage").insert({
    user_id: params.user_id,
    school_id: params.school_id,
    feature: params.feature,
    tokens_used: params.tokens_used,
    prompt_hash: params.prompt_hash,
    cached_result: params.cached_result,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error("[geminiService] saveUsageRecord error:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPromptHash(
  data: string,
  subject: string,
  class_level: string,
  difficulty: string,
  mcq_count: number,
  theory_count: number
): string {
  return crypto
    .createHash("md5")
    .update(data + subject + class_level + difficulty + mcq_count + theory_count)
    .digest("hex");
}
