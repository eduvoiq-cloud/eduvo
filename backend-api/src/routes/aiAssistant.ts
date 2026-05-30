import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import {
  extractFromFile,
  generateQuestions,
  checkDailyLimit,
  getCachedResult,
  saveUsageRecord,
  type ExtractionResult,
} from '../services/geminiService';

const router = Router();

// ── All routes require authentication + teacher role ──────────────────────────
router.use(authenticate);
router.use(requireRole('teacher'));

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt']);
const EXTRACTION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DAILY_GENERATIONS = parseInt(process.env.AI_MAX_DAILY_GENERATIONS ?? '10', 10);

// ── In-memory extraction cache ────────────────────────────────────────────────
// Keyed by extraction_id. Entries expire after EXTRACTION_CACHE_TTL_MS.

interface ExtractionEntry {
  extraction: ExtractionResult;
  expiresAt: number;
  teacher_id: string;
}

const extractionCache = new Map<string, ExtractionEntry>();

/** Remove expired entries from the cache. Called lazily on each upload. */
function pruneExtractionCache(): void {
  const now = Date.now();
  for (const [key, entry] of extractionCache.entries()) {
    if (entry.expiresAt <= now) {
      extractionCache.delete(key);
    }
  }
}

/** Retrieve a non-expired extraction entry, or null if missing/expired. */
function getExtraction(id: string): ExtractionEntry | null {
  const entry = extractionCache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    extractionCache.delete(id);
    return null;
  }
  return entry;
}

// ── Multer — memory storage, file-type validation ─────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = '.' + (file.originalname ?? '').split('.').pop()?.toLowerCase();
    const mime = file.mimetype.toLowerCase();

    if (ALLOWED_MIME_TYPES.has(mime) || ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .pdf, .docx, and .txt files are allowed'));
    }
  },
});

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** Max 20 uploads per teacher per hour. */
const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req) => `upload:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Upload limit reached (20 per hour). Please try again later.',
  },
});

/** Max 10 AI generations per teacher per day. */
const generateRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: (req) => `generate:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: `Daily limit of ${MAX_DAILY_GENERATIONS} generations reached. Resets tomorrow.`,
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sanitise a string: trim and strip control characters. */
function sanitise(value: string): string {
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

/** Insert a row into audit_logs. Errors are swallowed. */
async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}

/** Count how many AI generations the teacher has used today. */
async function getTodayUsageCount(userId: string, schoolId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count, error } = await supabaseAdmin
    .from('ai_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('school_id', schoolId)
    .gte('created_at', startOfDay.toISOString());

  if (error) {
    console.error('[aiAssistant] getTodayUsageCount error:', error.message);
    return 0;
  }

  return count ?? 0;
}

// ── POST /api/ai/upload-and-extract ──────────────────────────────────────────
/**
 * Accepts a single file upload (.pdf, .docx, .txt, max 5 MB).
 * Extracts text via geminiService, stores it in the in-memory cache for 10 min,
 * and returns a preview.
 */
router.post(
  '/upload-and-extract',
  uploadRateLimit,
  (req: Request, res: Response, next) => {
    // Run multer and convert its errors into clean API responses
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          sendError(
            res,
            `File too large. Maximum allowed size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
            413
          );
          return;
        }
        sendError(res, err.message ?? 'File upload failed', 400);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file uploaded. Please attach a .pdf, .docx, or .txt file.', 400);
      return;
    }

    // Double-check extension (multer fileFilter already validates, but be explicit)
    const ext = '.' + (req.file.originalname ?? '').split('.').pop()?.toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      sendError(res, 'Only .pdf, .docx, and .txt files are allowed.', 415);
      return;
    }

    // Prune stale cache entries before adding a new one
    pruneExtractionCache();

    let extraction: ExtractionResult;
    try {
      extraction = await extractFromFile(req.file);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to extract text from file';
      sendError(res, message, 422);
      return;
    }

    if (extraction.total_chars === 0) {
      sendError(res, 'No readable content found in the uploaded file.', 422);
      return;
    }

    // Store in cache
    const extractionId = crypto.randomUUID();
    extractionCache.set(extractionId, {
      extraction,
      expiresAt: Date.now() + EXTRACTION_CACHE_TTL_MS,
      teacher_id: req.user!.id,
    });

    // Log the upload for abuse detection
    await logAudit(req.user!.id, 'AI_FILE_UPLOADED', {
      extraction_id: extractionId,
      file_name: req.file.originalname,
      file_size: req.file.size,
      content_type: extraction.type,
      total_chars: extraction.total_chars,
    });

    sendSuccess(
      res,
      {
        extraction_id: extractionId,
        content_type: extraction.type,
        total_chars: extraction.total_chars,
      },
      'File uploaded successfully',
      201
    );
  }
);

// ── POST /api/ai/generate ─────────────────────────────────────────────────────
/**
 * Generates MCQ and theory questions from a previously extracted text.
 * Checks daily limit, uses prompt-hash cache to avoid duplicate API calls.
 */
router.post(
  '/generate',
  generateRateLimit,
  async (req: Request, res: Response) => {
    // ── Validation ────────────────────────────────────────────────────────────
    const schema = z.object({
      extraction_id: z.string().uuid('extraction_id must be a valid UUID'),
      subject: z.string().min(1).max(50),
      class_level: z.string().min(1).max(20),
      difficulty: z.enum(['easy', 'medium', 'hard']),
      mcq_count: z.number().int().min(1).max(30),
      theory_count: z.number().int().min(0).max(10),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.flatten());
      return;
    }

    const {
      extraction_id,
      subject,
      class_level,
      difficulty,
      mcq_count,
      theory_count,
    } = parsed.data;

    // ── Sanitise string inputs before passing to AI ───────────────────────────
    const safeSubject = sanitise(subject);
    const safeClassLevel = sanitise(class_level);

    // ── Verify extraction_id exists in cache ──────────────────────────────────
    const extraction = getExtraction(extraction_id);
    if (!extraction) {
      sendError(
        res,
        'extraction_id not found or has expired (10-minute limit). Please re-upload your file.',
        404
      );
      return;
    }

    // Ensure the extraction belongs to the requesting teacher
    if (extraction.teacher_id !== req.user!.id) {
      sendError(res, 'Access denied to this extraction.', 403);
      return;
    }

    const teacherId = req.user!.id;
    const schoolId = req.user!.school_id ?? '';

    // ── Daily limit check ─────────────────────────────────────────────────────
    const allowed = await checkDailyLimit(teacherId, schoolId);
    if (!allowed) {
      sendError(
        res,
        `Daily limit of ${MAX_DAILY_GENERATIONS} generations reached. Resets tomorrow.`,
        429
      );
      return;
    }

    // ── Prompt-hash cache check ───────────────────────────────────────────────
    const promptHash = crypto
      .createHash('md5')
      .update(
        extraction.extraction.data +
          safeSubject +
          safeClassLevel +
          difficulty +
          mcq_count +
          theory_count
      )
      .digest('hex');

    const cachedResult = await getCachedResult(promptHash);
    if (cachedResult) {
      // Return cached result — no Gemini API call needed
      await logAudit(teacherId, 'AI_GENERATE_CACHED', {
        extraction_id,
        prompt_hash: promptHash,
        subject: safeSubject,
        class_level: safeClassLevel,
        difficulty,
        mcq_count,
        theory_count,
      });

      sendSuccess(
        res,
        { ...JSON.parse(cachedResult), cached: true },
        'Questions retrieved from cache'
      );
      return;
    }

    // ── Call Gemini ───────────────────────────────────────────────────────────
    let questions;
    try {
      questions = await generateQuestions({
        extraction: extraction.extraction,
        subject: safeSubject,
        class_level: safeClassLevel,
        difficulty,
        mcq_count,
        theory_count,
        teacher_id: teacherId,
        school_id: schoolId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI generation failed';

      // Surface daily-limit errors as 429
      if (message.toLowerCase().includes('daily') && message.toLowerCase().includes('limit')) {
        sendError(res, `Daily limit of ${MAX_DAILY_GENERATIONS} generations reached. Resets tomorrow.`, 429);
        return;
      }

      sendError(res, message, 500);
      return;
    }

    // ── Log usage for abuse detection ─────────────────────────────────────────
    await logAudit(teacherId, 'AI_GENERATE_SUCCESS', {
      extraction_id,
      prompt_hash: promptHash,
      subject: safeSubject,
      class_level: safeClassLevel,
      difficulty,
      mcq_count,
      theory_count,
      mcq_generated: questions.mcq_questions.length,
      theory_generated: questions.theory_questions.length,
    });

    sendSuccess(res, { ...questions, cached: false }, 'Questions generated successfully');
  }
);

// ── POST /api/ai/save-test ────────────────────────────────────────────────────
/**
 * Saves the teacher-edited AI output as a test + questions in the database.
 * This is the final step after the teacher reviews and edits the generated questions.
 */
router.post('/save-test', async (req: Request, res: Response) => {
  // ── Validation ────────────────────────────────────────────────────────────
  const mcqSchema = z.object({
    question: z.string().min(1),
    option_a: z.string().min(1),
    option_b: z.string().min(1),
    option_c: z.string().min(1),
    option_d: z.string().min(1),
    correct_option: z.enum(['a', 'b', 'c', 'd']),
    marks: z.number().min(0.5),
  });

  const theorySchema = z.object({
    question: z.string().min(1),
    expected_answer: z.string().min(1),
    marks: z.number().min(0.5),
  });

  const saveTestSchema = z.object({
    title: z.string().min(1).max(200),
    subject_id: z.string().max(100).default(''),   // treated as subject text; uuid validation removed
    class: z.string().min(1).max(20),
    section: z.string().min(1).max(10),
    term: z.string().min(1).max(50),
    date: z.string().optional(),                   // ISO date string e.g. "2025-12-19"
    time_limit_minutes: z.number().int().min(1).max(300),
    shuffle_questions: z.boolean().default(false),
    shuffle_options: z.boolean().default(false),
    mcq_questions: z.array(mcqSchema).default([]),
    theory_questions: z.array(theorySchema).default([]),
  });

  const parsed = saveTestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const {
    title,
    subject_id,
    class: className,
    section,
    term,
    date,
    time_limit_minutes,
    shuffle_questions,
    shuffle_options,
    mcq_questions,
    theory_questions,
  } = parsed.data;

  if (mcq_questions.length === 0 && theory_questions.length === 0) {
    sendError(res, 'At least one question (MCQ or theory) is required.', 400);
    return;
  }

  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id ?? '';

  // ── Insert test record ────────────────────────────────────────────────────
  // Only insert columns guaranteed to exist in the base schema.
  // Extended columns (time_limit_minutes, shuffle_*) are added via migrations —
  // attempt them but fall back gracefully if the migration hasn't run yet.
  const testInsertBase = {
    title:      sanitise(title),
    subject:    sanitise(subject_id) || 'General', // subject_id carries the subject name
    class:      sanitise(className),               // live DB column is "class"
    section:    sanitise(section),
    term:       sanitise(term),
    date:       date || new Date().toISOString().split('T')[0],
    school_id:  schoolId,
    created_by: teacherId,
    created_at: new Date().toISOString(),
  };

  // Try with extended columns first
  let test: Record<string, unknown> | null = null;
  let testErr: { message: string } | null = null;

  const extendedResult = await supabaseAdmin
    .from('tests')
    .insert({ ...testInsertBase, time_limit_minutes, shuffle_questions, shuffle_options })
    .select()
    .single();

  if (extendedResult.error) {
    // If the error is about missing columns, retry with base columns only
    const msg = extendedResult.error.message ?? '';
    if (msg.includes('shuffle_options') || msg.includes('shuffle_questions') || msg.includes('time_limit_minutes')) {
      const baseResult = await supabaseAdmin
        .from('tests')
        .insert(testInsertBase)
        .select()
        .single();
      test = baseResult.data as Record<string, unknown> | null;
      testErr = baseResult.error;
    } else {
      testErr = extendedResult.error;
    }
  } else {
    test = extendedResult.data as Record<string, unknown> | null;
  }

  if (testErr || !test) {
    sendError(res, testErr?.message ?? 'Failed to create test', 500);
    return;
  }

  // ── Build question rows ───────────────────────────────────────────────────
  // Use the same column names as the working POST /api/tests compatibility route:
  // question_text, question_type, option_a/b/c/d, correct_option (letter), marks
  const questionRows: Record<string, unknown>[] = [];
  let orderIndex = 0;

  for (const q of mcq_questions) {
    questionRows.push({
      test_id:        test.id,
      order_index:    orderIndex++,
      question_text:  sanitise(q.question),
      question_type:  'mcq',
      option_a:       sanitise(q.option_a),
      option_b:       sanitise(q.option_b),
      option_c:       sanitise(q.option_c),
      option_d:       sanitise(q.option_d),
      correct_option: q.correct_option,  // letter: 'a'|'b'|'c'|'d'
      marks:          q.marks,
    });
  }

  for (const q of theory_questions) {
    questionRows.push({
      test_id:        test.id,
      order_index:    orderIndex++,
      question_text:  sanitise(q.question),
      question_type:  'theory',
      option_a:       null,
      option_b:       null,
      option_c:       null,
      option_d:       null,
      correct_option: null,
      marks:          q.marks,
    });
  }

  // ── Insert questions ──────────────────────────────────────────────────────
  const { error: qErr } = await supabaseAdmin.from('test_questions').insert(questionRows);

  if (qErr) {
    // Roll back the test header if questions fail
    await supabaseAdmin.from('tests').delete().eq('id', test.id);
    sendError(res, 'Failed to save questions. Test creation rolled back.', 500);
    return;
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await logAudit(teacherId, 'AI_TEST_SAVED', {
    test_id: test.id,
    title: test.title,
    class_name: className,
    section,
    term,
    mcq_count: mcq_questions.length,
    theory_count: theory_questions.length,
    total_questions: questionRows.length,
  });

  sendSuccess(
    res,
    { test_id: test.id },
    'Test saved successfully',
    201
  );
});

// ── GET /api/ai/usage ─────────────────────────────────────────────────────────
/**
 * Returns the teacher's AI generation usage for today.
 * Shown in the UI so the teacher knows their remaining quota.
 */
router.get('/usage', async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId = req.user!.school_id ?? '';

  const used = await getTodayUsageCount(teacherId, schoolId);
  const remaining = Math.max(0, MAX_DAILY_GENERATIONS - used);

  sendSuccess(res, {
    used,
    limit: MAX_DAILY_GENERATIONS,
    remaining,
  });
});

export default router;
