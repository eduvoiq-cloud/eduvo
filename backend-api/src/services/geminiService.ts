import { GoogleGenerativeAI } from "@google/generative-ai";
// pdf-parse v2.x uses a class-based API: new PDFParse({ data: buffer }).getText()
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require("pdf-parse");
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

export interface GenerateQuestionsParams {
  content: string;
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

const MAX_CONTENT_CHARS = 50_000;
const MAX_DAILY_GENERATIONS = parseInt(
  process.env.AI_MAX_DAILY_GENERATIONS ?? "10",
  10
);

// ---------------------------------------------------------------------------
// 1. extractTextFromFile
// ---------------------------------------------------------------------------

/**
 * Extracts plain text from an uploaded file (PDF, DOCX, or TXT).
 * Strips excess whitespace and truncates to MAX_CONTENT_CHARS.
 */
export async function extractTextFromFile(
  file: Express.Multer.File
): Promise<string> {
  const mime = file.mimetype.toLowerCase();
  const originalName = (file.originalname ?? "").toLowerCase();

  let raw = "";

  if (mime === "application/pdf" || originalName.endsWith(".pdf")) {
    const parser = new PDFParse({ data: file.buffer, verbosity: 0 });
    const result = await parser.getText();
    raw = result.text;
  } else if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    originalName.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    raw = result.value;
  } else if (
    mime === "text/plain" ||
    originalName.endsWith(".txt")
  ) {
    raw = file.buffer.toString("utf-8");
  } else {
    throw new Error(
      `Unsupported file type: ${file.mimetype}. Please upload a PDF, DOCX, or TXT file.`
    );
  }

  // Normalise whitespace
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate to control token cost
  return cleaned.length > MAX_CONTENT_CHARS
    ? cleaned.slice(0, MAX_CONTENT_CHARS)
    : cleaned;
}

// ---------------------------------------------------------------------------
// 2. generateQuestions
// ---------------------------------------------------------------------------

/**
 * Calls Gemini Flash 2.0 to generate MCQ and theory questions from content.
 * Checks the daily limit, uses cache when available, and saves usage records.
 */
export async function generateQuestions(
  params: GenerateQuestionsParams
): Promise<GeneratedContent> {
  const {
    content,
    subject,
    class_level,
    difficulty,
    mcq_count,
    theory_count,
    teacher_id,
    school_id,
  } = params;

  // Rate-limit check
  const allowed = await checkDailyLimit(teacher_id, school_id);
  if (!allowed) {
    throw new Error(
      `Daily AI generation limit of ${MAX_DAILY_GENERATIONS} reached. Please try again tomorrow.`
    );
  }

  // Build a deterministic hash for caching
  const promptHash = buildPromptHash(
    content,
    subject,
    class_level,
    difficulty,
    mcq_count,
    theory_count
  );

  // Return cached result if fresh
  const cached = await getCachedResult(promptHash);
  if (cached) {
    return JSON.parse(cached) as GeneratedContent;
  }

  // Build prompt
  const systemInstruction = [
    "You are an experienced teacher creating exam questions.",
    "Generate questions ONLY based on the provided content.",
    "Do NOT add information not present in the content.",
    "Do NOT hallucinate facts.",
    "Return ONLY valid JSON. No markdown, no explanation.",
  ].join("\n");

  const userPrompt = `<content>
${content}
</content>
<instructions>
Subject: ${subject}
Class: ${class_level}
Difficulty: ${difficulty}
Generate ${mcq_count} MCQ questions and ${theory_count} theory questions.
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
}
</instructions>`;

  // Call Gemini
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction,
  });

  const result = await model.generateContent(userPrompt);
  const responseText = result.response.text().trim();

  // Parse JSON response
  let parsed: GeneratedContent;
  try {
    // Strip any accidental markdown fences just in case
    const jsonText = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(jsonText) as GeneratedContent;
  } catch {
    throw new Error("AI returned invalid format, please retry");
  }

  // Estimate token usage from response metadata (may be 0 if not provided)
  const tokensUsed =
    result.response.usageMetadata?.totalTokenCount ?? 0;

  // Persist usage + cache
  await saveUsageRecord({
    user_id: teacher_id,
    school_id,
    feature: "question_generation",
    tokens_used: tokensUsed,
    prompt_hash: promptHash,
    cached_result: JSON.stringify(parsed),
  });

  return parsed;
}

// ---------------------------------------------------------------------------
// 3. checkDailyLimit
// ---------------------------------------------------------------------------

/**
 * Returns true if the user is still within their daily generation quota.
 */
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
    // Fail open — don't block the user if the DB check fails
    console.error("[geminiService] checkDailyLimit error:", error.message);
    return true;
  }

  return (count ?? 0) < MAX_DAILY_GENERATIONS;
}

// ---------------------------------------------------------------------------
// 4. getCachedResult
// ---------------------------------------------------------------------------

/**
 * Returns a cached JSON result string if one exists and is less than 24 h old.
 * Returns null otherwise.
 */
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

/**
 * Persists an AI usage record to the ai_usage table.
 * Used for both rate-limiting and result caching.
 */
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
    // Log but don't throw — a failed usage record shouldn't break the response
    console.error("[geminiService] saveUsageRecord error:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic MD5 hash from the generation parameters.
 * Used as a cache key.
 */
function buildPromptHash(
  content: string,
  subject: string,
  class_level: string,
  difficulty: string,
  mcq_count: number,
  theory_count: number
): string {
  return crypto
    .createHash("md5")
    .update(content + subject + class_level + difficulty + mcq_count + theory_count)
    .digest("hex");
}
