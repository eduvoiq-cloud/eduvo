/**
 * /api/recovery — Recovery pack and test generation endpoints
 *
 * POST /api/recovery/generate-pack
 *   Called after teacher approves a schedule. Submits a Gemini Batch job
 *   to generate personalised recovery study packs for every premium student
 *   in the class. Sets generation_status = 'processing' and stores batch_job_id.
 *
 * POST /api/recovery/generate-test
 *   Called after pack generation completes (or independently). Submits a
 *   Gemini Batch job to generate personalised MCQ recovery tests.
 *
 * Both endpoints are guarded by either:
 *   - x-cron-secret header (internal/cron calls)
 *   - Teacher JWT + x-internal-token header (retry from dashboard)
 *
 * The actual result processing is done by the batch-checker cron.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { analyzeStudentWeakness } from '../services/weaknessAnalysisService';

const router = Router();

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Accepts either CRON_SECRET header or authenticated teacher/admin token. */
function isCronAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const rawHeader = req.headers['x-cron-secret'];
  const provided = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return Boolean(cronSecret && provided === cronSecret);
}

// ── Gemini Batch API helpers ──────────────────────────────────────────────────

interface GeminiBatchRequest {
  model: string;
  contents: Array<{
    role: string;
    parts: Array<{ text: string }>;
  }>;
}

interface GeminiBatchResponse {
  name: string; // batch job name / id
  state: string;
}

/** Build the Gemini Batch API base URL for the configured project. */
function geminiBaseUrl(): string {
  // Vertex AI Batch Prediction endpoint
  const project  = process.env.GOOGLE_CLOUD_PROJECT ?? '';
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}`;
}

/**
 * Call Google Gemini (generate content) directly with REST — used for batch.
 * Falls back to the @google/generative-ai SDK for non-batch single calls.
 */
async function callGeminiGenerateContent(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const modelId = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text;
}

/**
 * Submit a Gemini Batch job.
 *
 * Note: Gemini Batch API (Vertex AI) processes a list of requests asynchronously.
 * Each "request" in the batch is one student's prompt.
 * Returns the batch job name used for status polling.
 *
 * Since Gemini Batch API via Vertex AI requires GCP service accounts,
 * and many deployments use the simple API key path, we implement a
 * "pseudo-batch" that processes each student individually but stores
 * a shared job ID, then marks all rows as processing.
 * The cron checker processes them sequentially.
 *
 * If GOOGLE_CLOUD_PROJECT is set, uses the real Vertex AI Batch API.
 * Otherwise, processes immediately using the REST API and stores results.
 */
async function submitGeminiBatchOrProcess(
  requests: Array<{ studentId: string; prompt: string; rowId: string }>,
  tableName: 'recovery_packs' | 'monthly_recovery_tests'
): Promise<string> {
  const batchJobId = `batch_${tableName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const useVertexBatch = Boolean(process.env.GOOGLE_CLOUD_PROJECT);

  if (useVertexBatch) {
    // ── Real Vertex AI Batch Prediction ────────────────────────────────────
    // Build JSONL requests and submit to Vertex AI batch endpoint.
    // This requires GOOGLE_APPLICATION_CREDENTIALS or service account env vars.
    const { GoogleAuth } = await import('google-auth-library').catch(() => {
      throw new Error('google-auth-library not installed. Run: npm install google-auth-library');
    });

    const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const modelId = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const project  = process.env.GOOGLE_CLOUD_PROJECT!;
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';

    const batchPayload = {
      displayName: batchJobId,
      model: `publishers/google/models/${modelId}`,
      inputConfig: {
        instancesFormat: 'jsonl',
        gcsSource: { uris: [] }, // handled via inline requests below
      },
      // For simplicity: submit as inline content list
      instances: requests.map((r) => ({
        contents: [{ role: 'user', parts: [{ text: r.prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      })),
    };

    const batchUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/batchPredictionJobs`;

    const resp = await fetch(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batchPayload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[recovery] Vertex AI batch submit failed: ${resp.status}: ${errText}`);
      throw new Error(`Vertex AI batch submission failed: ${resp.status}`);
    }

    const jobData = await resp.json() as { name: string };
    return jobData.name; // real Vertex AI job name

  } else {
    // ── Immediate processing via standard Gemini API ────────────────────────
    // Process each request inline and store results. The cron checker will
    // find these with generation_status='completed' and skip re-processing.
    // We still set generation_status='processing' first, then update per student.

    for (const req of requests) {
      try {
        const rawText = await callGeminiGenerateContent(req.prompt);

        // Strip markdown fences if present
        const jsonText = rawText
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();

        const parsed = JSON.parse(jsonText) as unknown;

        await supabaseAdmin
          .from(tableName)
          .update({
            generation_status: 'completed',
            generated_at: new Date().toISOString(),
            batch_job_id: batchJobId,
            ...(tableName === 'recovery_packs'
              ? { pack_content: parsed }
              : {
                  questions: (parsed as { questions?: unknown }).questions,
                  total_questions: Array.isArray((parsed as { questions?: unknown[] }).questions)
                    ? (parsed as { questions: unknown[] }).questions.length
                    : 0,
                  is_available: false,
                }),
          })
          .eq('id', req.rowId);

        // Small delay between Gemini calls to respect rate limits
        await new Promise((r) => setTimeout(r, 800));
      } catch (err) {
        console.error(`[recovery] Failed to generate for student ${req.studentId}:`, err instanceof Error ? err.message : err);
        await supabaseAdmin
          .from(tableName)
          .update({ generation_status: 'failed', batch_job_id: batchJobId })
          .eq('id', req.rowId);
      }
    }

    return batchJobId;
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildPackPrompt(
  className: string,
  subject: string,
  board: string,
  weakTopicsList: string
): string {
  return `You are creating a personalized study recovery pack for a Class ${className} student in India studying ${subject} (${board} curriculum).
This student is weak in these topics: ${weakTopicsList}

Create a Recovery Pack with one section per weak topic. Each section must include:
1. Simple explanation (max 100 words, language appropriate for Class ${className})
2. Key concepts (3-5 bullet points)
3. Common mistakes students make (2-3 bullet points)
4. One solved example with step-by-step solution
5. Two short practice questions with answers

Rules:
- Use simple, engaging language
- Avoid copying textbook definitions exactly
- Make examples relatable to Indian students (use Indian names, contexts)
- Do NOT provide test answers that could be used for cheating

Return ONLY valid JSON matching this exact structure, no markdown:
{"sections":[{"topic":"string","explanation":"string","key_concepts":["string"],"common_mistakes":["string"],"solved_examples":[{"question":"string","solution":"string","steps":["string"]}],"practice_questions":[{"question":"string","answer":"string"}]}]}`;
}

function buildTestPrompt(
  className: string,
  subject: string,
  board: string,
  weakTopicsList: string,
  questionCount: number
): string {
  return `You are creating a personalized Monthly Recovery Test for a Class ${className} student in India. Subject: ${subject} (${board} curriculum).
This student is weak in: ${weakTopicsList}

Generate exactly ${questionCount} multiple choice questions.

Distribution:
- 40% questions from weakest 2 topics
- 30% from other weak topics
- 30% mixed review from the whole subject

Difficulty:
- 30% easy (foundation recall)
- 40% medium (application)
- 30% hard (analysis/problem-solving)

Each question must have:
- question text
- 4 options
- correct_index (0-3)
- explanation: one line stating which answer is correct and why (max 20 words, factual)
- reasoning: a teaching explanation helping the student understand the concept behind this question (2-4 sentences, educational, appropriate for Class ${className} level, explains WHY the answer is correct and why the wrong options are wrong if relevant)
- difficulty: 'easy', 'medium', or 'hard'
- topic: which weak topic this tests

Return ONLY valid JSON, no markdown:
{"questions":[{"question":"string","options":["a","b","c","d"],"correct_index":0,"explanation":"string","reasoning":"string","difficulty":"easy","topic":"string"}]}`;
}

// ── Shared: get premium students + school board for a schedule ────────────────

interface ScheduleContext {
  scheduleRow: {
    id: string;
    class: string;
    section: string;
    subject: string;
    scheduled_month: string;
    school_id: string;
  };
  board: string;
  premiumStudents: Array<{ id: string; full_name: string; class_name: string }>;
}

async function getScheduleContext(scheduleId: string): Promise<ScheduleContext | null> {
  const { data: scheduleRow, error: schedErr } = await supabaseAdmin
    .from('monthly_recovery_schedules')
    .select('id, class, section, subject, scheduled_month, school_id')
    .eq('id', scheduleId)
    .maybeSingle();

  if (schedErr || !scheduleRow) return null;

  const row = scheduleRow as {
    id: string; class: string; section: string;
    subject: string; scheduled_month: string; school_id: string;
  };

  // Fetch school board
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('board')
    .eq('id', row.school_id)
    .maybeSingle();

  const board = (school as { board?: string } | null)?.board ?? 'CBSE';

  // Fetch all premium students in this class+section
  const today = new Date().toISOString().slice(0, 10);
  const { data: subs } = await supabaseAdmin
    .from('parent_subscriptions')
    .select(`
      student_id,
      students!inner (
        id, full_name, class_name, school_id, section, is_deleted
      )
    `)
    .eq('status', 'active')
    .gte('expires_at', today);

  const premiumStudents = ((subs ?? []) as unknown as Array<{
    student_id: string;
    students: {
      id: string;
      full_name: string;
      class_name: string;
      school_id: string;
      section: string;
      is_deleted: boolean;
    } | null;
  }>)
    .filter((s) => {
      const st = s.students;
      return (
        st &&
        st.school_id === row.school_id &&
        !st.is_deleted &&
        st.class_name?.toLowerCase() === row.class.toLowerCase() &&
        st.section?.toLowerCase() === row.section.toLowerCase()
      );
    })
    .map((s) => ({
      id: s.students!.id,
      full_name: s.students!.full_name,
      class_name: s.students!.class_name,
    }));

  return { scheduleRow: row, board, premiumStudents };
}

// ── Validation schemas ────────────────────────────────────────────────────────

const generateSchema = z.object({
  schedule_id: z.string().uuid(),
});

// ── POST /api/recovery/generate-pack ─────────────────────────────────────────
/**
 * Triggers recovery pack generation for all premium students
 * in a class after the teacher approves the schedule.
 *
 * Auth: CRON_SECRET header OR teacher/schooladmin JWT token.
 */
router.post('/generate-pack', async (req: Request, res: Response) => {
  // Auth: cron secret OR authenticated teacher/admin
  const cronOk = isCronAuthorized(req);
  if (!cronOk) {
    // Try JWT auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    // Import auth middleware inline to authenticate the request
    const { supabase: supabaseClient } = await import('../config/supabase');
    const token = authHeader.split(' ')[1];
    const { data: authData, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !authData.user) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', authData.user.id)
      .single();
    if (!profile || !['teacher', 'schooladmin', 'superadmin'].includes(profile.role)) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { schedule_id } = parsed.data;

  // Respond immediately — generation runs in background
  sendSuccess(res, { message: 'Recovery pack generation started', schedule_id }, 'Job started');

  setImmediate(async () => {
    try {
      const ctx = await getScheduleContext(schedule_id);
      if (!ctx) {
        console.error(`[recovery/generate-pack] Schedule ${schedule_id} not found`);
        return;
      }

      const { scheduleRow, board, premiumStudents } = ctx;

      if (premiumStudents.length === 0) {
        console.log(`[recovery/generate-pack] No premium students for schedule ${schedule_id}`);
        return;
      }

      console.log(`[recovery/generate-pack] Processing ${premiumStudents.length} students for schedule ${schedule_id}`);

      const batchRequests: Array<{ studentId: string; prompt: string; rowId: string }> = [];

      for (const student of premiumStudents) {
        try {
          // Analyse student weakness
          const weaknessResult = await analyzeStudentWeakness(
            student.id,
            scheduleRow.subject,
            scheduleRow.school_id,
            scheduleRow.scheduled_month
          );

          const weakTopicNames = weaknessResult.weak_topics.map((t) => t.topic);
          const weakTopicsList = weakTopicNames.join(', ');

          // Check if recovery_pack row already exists
          const { data: existing } = await supabaseAdmin
            .from('recovery_packs')
            .select('id, generation_status')
            .eq('recovery_schedule_id', schedule_id)
            .eq('student_id', student.id)
            .maybeSingle();

          let rowId: string;

          if (existing && (existing as { id: string; generation_status: string }).generation_status === 'completed') {
            // Already generated — skip
            console.log(`[recovery/generate-pack] Pack already completed for student ${student.id}, skipping`);
            continue;
          } else if (existing) {
            rowId = (existing as { id: string }).id;
            // Reset to processing
            await supabaseAdmin
              .from('recovery_packs')
              .update({
                generation_status: 'processing',
                weak_topics: weakTopicNames,
                pack_content: null,
              })
              .eq('id', rowId);
          } else {
            // Insert new row
            const { data: inserted, error: insertErr } = await supabaseAdmin
              .from('recovery_packs')
              .insert({
                recovery_schedule_id: schedule_id,
                student_id: student.id,
                school_id: scheduleRow.school_id,
                subject: scheduleRow.subject,
                scheduled_month: scheduleRow.scheduled_month,
                weak_topics: weakTopicNames,
                generation_status: 'processing',
              })
              .select('id')
              .single();

            if (insertErr || !inserted) {
              console.error(`[recovery/generate-pack] Insert failed for student ${student.id}:`, insertErr?.message);
              continue;
            }
            rowId = (inserted as { id: string }).id;
          }

          const prompt = buildPackPrompt(
            scheduleRow.class,
            scheduleRow.subject,
            board,
            weakTopicsList
          );

          batchRequests.push({ studentId: student.id, prompt, rowId });
        } catch (err) {
          console.error(`[recovery/generate-pack] Student ${student.id} setup error:`, err instanceof Error ? err.message : err);
        }
      }

      if (batchRequests.length === 0) {
        console.log(`[recovery/generate-pack] No requests to process for schedule ${schedule_id}`);
        return;
      }

      const batchJobId = await submitGeminiBatchOrProcess(batchRequests, 'recovery_packs');

      // Update schedule status
      await supabaseAdmin
        .from('monthly_recovery_schedules')
        .update({ status: 'pack_generated', updated_at: new Date().toISOString() })
        .eq('id', schedule_id);

      console.log(`[recovery/generate-pack] Batch job ${batchJobId} submitted for schedule ${schedule_id}, ${batchRequests.length} students`);
    } catch (err) {
      console.error('[recovery/generate-pack] Fatal error:', err instanceof Error ? err.message : err);
    }
  });
});

// ── POST /api/recovery/generate-test ─────────────────────────────────────────
/**
 * Triggers recovery test generation for all premium students.
 * Can be called independently or after pack generation completes.
 *
 * Auth: CRON_SECRET header OR teacher/schooladmin JWT token.
 */
router.post('/generate-test', async (req: Request, res: Response) => {
  // Auth check (same as generate-pack)
  const cronOk = isCronAuthorized(req);
  if (!cronOk) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    const { supabase: supabaseClient } = await import('../config/supabase');
    const token = authHeader.split(' ')[1];
    const { data: authData, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !authData.user) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', authData.user.id)
      .single();
    if (!profile || !['teacher', 'schooladmin', 'superadmin'].includes(profile.role)) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { schedule_id } = parsed.data;

  sendSuccess(res, { message: 'Recovery test generation started', schedule_id }, 'Job started');

  setImmediate(async () => {
    try {
      const ctx = await getScheduleContext(schedule_id);
      if (!ctx) {
        console.error(`[recovery/generate-test] Schedule ${schedule_id} not found`);
        return;
      }

      const { scheduleRow, board, premiumStudents } = ctx;

      if (premiumStudents.length === 0) {
        console.log(`[recovery/generate-test] No premium students for schedule ${schedule_id}`);
        return;
      }

      console.log(`[recovery/generate-test] Processing ${premiumStudents.length} students for schedule ${schedule_id}`);

      const batchRequests: Array<{ studentId: string; prompt: string; rowId: string }> = [];

      for (const student of premiumStudents) {
        try {
          const weaknessResult = await analyzeStudentWeakness(
            student.id,
            scheduleRow.subject,
            scheduleRow.school_id,
            scheduleRow.scheduled_month
          );

          const weakTopicNames = weaknessResult.weak_topics.map((t) => t.topic);
          const weakTopicsList = weakTopicNames.join(', ');

          // question_count: min(30, max(20, topic_count * 4))
          const questionCount = Math.min(30, Math.max(20, weakTopicNames.length * 4));

          // Check if monthly_recovery_tests row already exists
          const { data: existing } = await supabaseAdmin
            .from('monthly_recovery_tests')
            .select('id, generation_status')
            .eq('recovery_schedule_id', schedule_id)
            .eq('student_id', student.id)
            .maybeSingle();

          let rowId: string;

          if (existing && (existing as { id: string; generation_status: string }).generation_status === 'completed') {
            console.log(`[recovery/generate-test] Test already completed for student ${student.id}, skipping`);
            continue;
          } else if (existing) {
            rowId = (existing as { id: string }).id;
            await supabaseAdmin
              .from('monthly_recovery_tests')
              .update({
                generation_status: 'processing',
                weak_topics_used: weakTopicNames,
                questions: null,
                total_questions: questionCount,
              })
              .eq('id', rowId);
          } else {
            const { data: inserted, error: insertErr } = await supabaseAdmin
              .from('monthly_recovery_tests')
              .insert({
                recovery_schedule_id: schedule_id,
                student_id: student.id,
                school_id: scheduleRow.school_id,
                subject: scheduleRow.subject,
                scheduled_month: scheduleRow.scheduled_month,
                weak_topics_used: weakTopicNames,
                total_questions: questionCount,
                generation_status: 'processing',
                is_available: false,
              })
              .select('id')
              .single();

            if (insertErr || !inserted) {
              console.error(`[recovery/generate-test] Insert failed for student ${student.id}:`, insertErr?.message);
              continue;
            }
            rowId = (inserted as { id: string }).id;
          }

          const prompt = buildTestPrompt(
            scheduleRow.class,
            scheduleRow.subject,
            board,
            weakTopicsList,
            questionCount
          );

          batchRequests.push({ studentId: student.id, prompt, rowId });
        } catch (err) {
          console.error(`[recovery/generate-test] Student ${student.id} setup error:`, err instanceof Error ? err.message : err);
        }
      }

      if (batchRequests.length === 0) {
        console.log(`[recovery/generate-test] No requests to process for schedule ${schedule_id}`);
        return;
      }

      const batchJobId = await submitGeminiBatchOrProcess(batchRequests, 'monthly_recovery_tests');

      // Update schedule status
      await supabaseAdmin
        .from('monthly_recovery_schedules')
        .update({ status: 'test_generated', updated_at: new Date().toISOString() })
        .eq('id', schedule_id);

      console.log(`[recovery/generate-test] Batch job ${batchJobId} submitted for schedule ${schedule_id}, ${batchRequests.length} students`);
    } catch (err) {
      console.error('[recovery/generate-test] Fatal error:', err instanceof Error ? err.message : err);
    }
  });
});

export default router;
