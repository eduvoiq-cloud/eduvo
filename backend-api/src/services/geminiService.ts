import { type Part } from "@google/generative-ai";
import { geminiRawWithFallback } from "../utils/geminiRaw";
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

  // â”€â”€ PDF: send as base64 directly to Gemini vision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mime === "application/pdf" || originalName.endsWith(".pdf")) {
    const base64 = file.buffer.toString("base64");
    return {
      type: "pdf_base64",
      data: base64,
      total_chars: base64.length,
    };
  }

  // â”€â”€ DOCX: extract text with mammoth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    originalName.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    const cleaned = cleanText(result.value);
    return {
      type: "text",
      data: cleaned,
      total_chars: cleaned.length,
    };
  }

  // â”€â”€ TXT: read as utf-8 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mime === "text/plain" || originalName.endsWith(".txt")) {
    const cleaned = cleanText(file.buffer.toString("utf-8"));
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
 * For PDFs: sends the file as inlineData (vision) â€” works for scanned PDFs too.
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

  // Rate-limit check
  const allowed = await checkDailyLimit(teacher_id, school_id);
  if (!allowed) {
    throw new Error(
      `Daily AI generation limit of ${MAX_DAILY_GENERATIONS} reached. Please try again tomorrow.`
    );
  }

  // Build a deterministic hash â€” return cached result if available
  const promptHash = buildPromptHash(
    extraction.data,
    school_id,
    teacher_id,
    subject,
    class_level,
    difficulty,
    mcq_count,
    theory_count
  );
  const cached = await getCachedResult(promptHash);
  if (cached) {
    return JSON.parse(cached) as GeneratedContent;
  }

  // â”€â”€ Build Gemini request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // Send PDF as inline vision data â€” Gemini reads it natively (scanned or digital)
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

  // â”€â”€ Response schema for structured JSON output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mirrors the pattern used in tests.ts /generate â€” tells Gemini to return
  // clean JSON without markdown fences or prose wrappers.
  const responseSchema = {
    type: "object" as const,
    properties: {
      mcq_questions: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            question:       { type: "string" as const },
            option_a:       { type: "string" as const },
            option_b:       { type: "string" as const },
            option_c:       { type: "string" as const },
            option_d:       { type: "string" as const },
            correct_option: { type: "string" as const, enum: ["a", "b", "c", "d"] },
            marks:          { type: "integer" as const },
          },
          required: ["question", "option_a", "option_b", "option_c", "option_d", "correct_option", "marks"],
        },
      },
      theory_questions: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            question:        { type: "string" as const },
            expected_answer: { type: "string" as const },
            marks:           { type: "integer" as const },
          },
          required: ["question", "expected_answer", "marks"],
        },
      },
    },
    required: ["mcq_questions", "theory_questions"],
  };

  // Use GEMINI_MODEL_QUESTIONS for question generation (same as tests.ts /generate).
  // Flash Lite is sufficient â€” MCQ generation is simple extraction, not complex reasoning.
  // GEMINI_MODEL (full Flash) is reserved for homework eval and monthly reports.
  // Uses raw REST API so thinkingBudget:0 is guaranteed to reach the API (SDK v0.24 drops it).
  const modelId = process.env.GEMINI_MODEL_QUESTIONS ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
  const fallbackModelId = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  let rawText = '';
  let tokensUsed = 0;
  let thinkingTokens = 0;
  let t_gs3_geminiCallStart = performance.now();

  try {
    const result = await geminiRawWithFallback(modelId, fallbackModelId, {
      apiKey,
      parts: requestParts as Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
      systemInstruction,
      responseSchema: responseSchema as Record<string, unknown>,
      disableThinking: true,
    });
    rawText = result.text;
    tokensUsed = result.totalTokens;
    thinkingTokens = result.thinkingTokens;
  } catch (err) {
    throw err;
  }

  const t_gs4_geminiCallDone = performance.now();

  if (thinkingTokens > 0) {
    console.warn(`[geminiService] thinking tokens fired: ${thinkingTokens} â€” check thinkingBudget config`);
  }

  // Parse JSON â€” strip accidental markdown fences
  let parsed: GeneratedContent;
  try {
    const jsonText = rawText
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

  console.info(
    `[gemini] generateQuestions done in ${((t_gs6_dbSaveDone - t_gs0) / 1000).toFixed(2)}s` +
    ` | tokens: ${tokensUsed}` +
    ` | api: ${((t_gs4_geminiCallDone - t_gs3_geminiCallStart) / 1000).toFixed(2)}s`
  );

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
  school_id: string,
  teacher_id: string,
  subject: string,
  class_level: string,
  difficulty: string,
  mcq_count: number,
  theory_count: number
): string {
  return crypto
    .createHash("sha256")
    .update(data + school_id + teacher_id + subject + class_level + difficulty + mcq_count + theory_count)
    .digest("hex");
}
