/**
 * /api/recovery — Teacher-initiated recovery system
 *
 * POST /api/recovery/start-pack
 * POST /api/recovery/start-tests
 * GET  /api/recovery/cycle-status
 * GET  /api/recovery/test-results
 * POST /api/recovery/attempt/start
 * POST /api/recovery/attempt/submit
 *
 * Pack + test generation use the Gemini Batch API (50% cheaper, async).
 * Teacher clicks → batch job submitted → "ready in a few hours" message shown.
 * The /api/cron/recovery/check-batch-jobs cron picks up results every 2 hours.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, authenticateStudent } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';
import { analyzeStudentWeakness, StudentProfileType } from '../services/weaknessAnalysisService';

const router = Router();

// ── Gemini Batch API helper ───────────────────────────────────────────────────

/**
 * Submit a list of prompts as a single Gemini Batch API job.
 * Returns the batch job name (e.g. "batches/abc123") which is used to poll status.
 * Cost: 50% of standard per-request pricing.
 */
async function submitGeminiBatchJob(
  requests: Array<{ key: string; prompt: string }>
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const modelId = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const inlineRequests = requests.map(({ key, prompt }) => ({
    key,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    },
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchGenerateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: inlineRequests }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini Batch API error ${response.status}: ${err}`);
  }

  const data = await response.json() as { name?: string };
  if (!data.name) throw new Error('Gemini Batch API did not return a job name');
  return data.name;
}

// ── Fallback: single Gemini call (used by cron retry logic) ──────────────────

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
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callGeminiJSON<T>(prompt: string): Promise<T> {
  const raw = await callGeminiGenerateContent(prompt);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned) as T;
}

// Export for use by cron batch-job result processor
export { callGeminiJSON };

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildPackPromptWeak(
  className: string,
  subject: string,
  board: string,
  topics: string[]
): string {
  const topicList = topics.slice(0, 4).join(', ');
  return `You are creating a personalised remediation recovery pack for a Class ${className} student in India studying ${subject} (${board} curriculum).
This student needs help with these topics: ${topicList}

Create one section per topic (max 4 topics). Each section must include:
1. explanation: simple explanation, max 100 words, age-appropriate for Class ${className}
2. key_concepts: 3-5 bullet points
3. common_mistakes: 2-3 bullet points of mistakes students make
4. solved_examples: exactly 1, with step-by-step solution using Indian names/contexts
5. practice_questions: exactly 2 short questions with answers

Return ONLY valid JSON, no markdown fences:
{"sections":[{"topic":"string","explanation":"string","key_concepts":["string"],"common_mistakes":["string"],"solved_examples":[{"question":"string","solution":"string","steps":["string"]}],"practice_questions":[{"question":"string","answer":"string"}]}]}`;
}

function buildPackPromptNoData(
  className: string,
  subject: string,
  board: string
): string {
  return `You are creating a curiosity and overview recovery pack for a Class ${className} student in India studying ${subject} (${board} curriculum).
This student has no test history yet — introduce them to the major topics of this subject in an engaging way.

Cover 4 major topics of ${subject} for Class ${className} ${board}. For each topic:
1. explanation: engaging overview (max 100 words), tone: "let's explore this subject"
2. key_concepts: 3 bullet points of the most important ideas
3. common_mistakes: 1-2 bullet points (common beginner mistakes)
4. solved_examples: exactly 1, simple and relatable
5. practice_questions: exactly 1 easy question with answer

Return ONLY valid JSON, no markdown fences:
{"sections":[{"topic":"string","explanation":"string","key_concepts":["string"],"common_mistakes":["string"],"solved_examples":[{"question":"string","solution":"string","steps":["string"]}],"practice_questions":[{"question":"string","answer":"string"}]}]}`;
}

function buildPackPromptEnrichment(
  className: string,
  subject: string,
  board: string
): string {
  return `You are creating an extension/challenge recovery pack for a high-achieving Class ${className} student in India studying ${subject} (${board} curriculum).
This student has mastered the standard syllabus. Give them advanced, beyond-syllabus content.

Cover 4 advanced or extension topics in ${subject}. Tone: "You've mastered the basics — here's something to challenge you."
For each topic:
1. explanation: advanced explanation with real-world applications (max 100 words)
2. key_concepts: 4-5 challenging concepts
3. common_mistakes: 2 mistakes even good students make
4. solved_examples: exactly 1, a harder problem with detailed solution
5. practice_questions: exactly 2 hard practice questions with answers

Return ONLY valid JSON, no markdown fences:
{"sections":[{"topic":"string","explanation":"string","key_concepts":["string"],"common_mistakes":["string"],"solved_examples":[{"question":"string","solution":"string","steps":["string"]}],"practice_questions":[{"question":"string","answer":"string"}]}]}`;
}

function buildTestPrompt(
  className: string,
  subject: string,
  board: string,
  topics: string[],
  questionCount: number,
  profileType: StudentProfileType
): string {
  const topicList = topics.join(', ');
  const difficultyLine =
    profileType === 'enrichment'
      ? '20% easy, 30% medium, 50% hard'
      : profileType === 'no_data'
      ? '40% easy, 40% medium, 20% hard'
      : '30% easy, 40% medium, 30% hard';

  return `You are creating a personalised recovery test for a Class ${className} student in India. Subject: ${subject} (${board} curriculum).
Topics: ${topicList}

Generate exactly ${questionCount} multiple choice questions.
Difficulty distribution: ${difficultyLine}

Each question must have:
- question: question text
- options: array of exactly 4 strings
- correct_index: integer 0-3
- explanation: one factual line, max 20 words
- reasoning: teaching explanation, 2-4 sentences, why the answer is correct
- difficulty: "easy", "medium", or "hard"
- topic: which topic this tests

Return ONLY valid JSON, no markdown fences:
{"questions":[{"question":"string","options":["a","b","c","d"],"correct_index":0,"explanation":"string","reasoning":"string","difficulty":"easy","topic":"string"}]}`;
}

/**
 * Build a test prompt that generates questions DIRECTLY from the student's recovery pack content.
 * If pack_content is available, questions are based on what the student actually studied.
 * Falls back to topic-based generation if pack_content is not available.
 */
function buildTestPromptFromPack(
  className: string,
  subject: string,
  board: string,
  topics: string[],
  questionCount: number,
  profileType: StudentProfileType,
  packContent: unknown
): string {
  const difficultyLine =
    profileType === 'enrichment'
      ? '20% easy, 30% medium, 50% hard'
      : profileType === 'no_data'
      ? '40% easy, 40% medium, 20% hard'
      : '30% easy, 40% medium, 30% hard';

  if (packContent) {
    // Questions come directly from the pack the student will study
    const packJson = JSON.stringify(packContent);
    return `You are creating a personalised recovery test for a Class ${className} student in India. Subject: ${subject} (${board} curriculum).

The student has been given the following recovery study pack to read:
${packJson}

Generate exactly ${questionCount} multiple choice questions based ONLY on the content in this recovery pack above.
Questions must test understanding of the explanations, key concepts, solved examples, and practice questions from the pack.
Difficulty distribution: ${difficultyLine}

Each question must have:
- question: question text
- options: array of exactly 4 strings
- correct_index: integer 0-3
- explanation: one factual line, max 20 words, referencing the pack content
- reasoning: teaching explanation, 2-4 sentences, why the answer is correct
- difficulty: "easy", "medium", or "hard"
- topic: which topic from the pack this tests

Return ONLY valid JSON, no markdown fences:
{"questions":[{"question":"string","options":["a","b","c","d"],"correct_index":0,"explanation":"string","reasoning":"string","difficulty":"easy","topic":"string"}]}`;
  }

  // Fallback: topic-based (pack content not ready yet)
  return buildTestPrompt(className, subject, board, topics, questionCount, profileType);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Middleware stack for teacher/schooladmin routes */
const teacherAuth = [authenticate, requireRole('teacher', 'schooladmin')];

/** Get teacher's class+section assignments */
async function getTeacherClassSections(
  teacherId: string,
  schoolId: string
): Promise<Array<{ class_name: string; section: string; subject: string }>> {
  const { data } = await supabaseAdmin
    .from('teacher_assignments')
    .select('class_name, section, subject')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId);
  return (data ?? []) as Array<{ class_name: string; section: string; subject: string }>;
}

/** Get all subjects a teacher teaches in a given class+section */
async function getTeacherSubjectsForClass(
  teacherId: string,
  schoolId: string,
  className: string,
  section: string
): Promise<string[]> {
  const assignments = await getTeacherClassSections(teacherId, schoolId);
  const subjects = assignments
    .filter((a) => a.class_name === className && a.section === section)
    .map((a) => a.subject);
  return [...new Set(subjects)];
}

/** Fetch school board */
async function getSchoolBoard(schoolId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('schools')
    .select('board')
    .eq('id', schoolId)
    .maybeSingle();
  return (data as { board?: string } | null)?.board ?? 'CBSE';
}

/** Fetch all active students in a class+section */
async function getStudentsInClass(
  schoolId: string,
  className: string,
  section: string
): Promise<Array<{ id: string; full_name: string }>> {
  const { data } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .eq('school_id', schoolId)
    .eq('is_deleted', false)
    .ilike('class_name', className)
    .ilike('section', section);
  return (data ?? []) as Array<{ id: string; full_name: string }>;
}

// ── POST /api/recovery/start-pack ────────────────────────────────────────────

const startPackSchema = z.object({
  class: z.string().min(1),
  section: z.string().min(1),
});

router.post('/start-pack', ...teacherAuth, async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id as string;
  if (!schoolId) { sendError(res, 'No school associated with your account', 403); return; }

  const parsed = startPackSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }
  const { class: className, section } = parsed.data;

  // Check 30-day lockout
  const now = new Date();
  const { data: activeCycle } = await supabaseAdmin
    .from('recovery_cycles')
    .select('id, status, lockout_until, pack_generated_at')
    .eq('school_id', schoolId)
    .eq('class', className)
    .eq('section', section)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeCycle) {
    const c = activeCycle as { id: string; status: string; lockout_until: string | null; pack_generated_at: string | null };
    if (c.lockout_until && new Date(c.lockout_until) > now) {
      const daysLeft = Math.ceil((new Date(c.lockout_until).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      sendError(res, `Class is locked out for ${daysLeft} more day(s). Next cycle available on ${c.lockout_until}.`, 429);
      return;
    }
  }

  const lockoutUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Create new cycle
  const { data: cycle, error: cycleErr } = await supabaseAdmin
    .from('recovery_cycles')
    .insert({
      school_id: schoolId,
      class: className,
      section,
      created_by: teacherId,
      status: 'generating_pack',
      pack_generated_at: now.toISOString(),
      lockout_until: lockoutUntil,
    })
    .select('id')
    .single();

  if (cycleErr || !cycle) { sendError(res, cycleErr?.message ?? 'Failed to create cycle', 500); return; }
  const cycleId = (cycle as { id: string }).id;

  sendSuccess(res, { cycle_id: cycleId, lockout_until: lockoutUntil }, 'Recovery pack generation started');

  // Submit Gemini Batch API job in background — teacher does not wait for this
  setImmediate(async () => {
    try {
      const [subjects, students, board] = await Promise.all([
        getTeacherSubjectsForClass(teacherId, schoolId, className, section),
        getStudentsInClass(schoolId, className, section),
        getSchoolBoard(schoolId),
      ]);

      if (students.length === 0 || subjects.length === 0) {
        // Nothing to generate — mark ready immediately
        await supabaseAdmin.from('recovery_cycles').update({
          status: 'pack_ready',
          updated_at: new Date().toISOString(),
        }).eq('id', cycleId);
        return;
      }

      const currentMonth = now.toISOString().slice(0, 7) + '-01';

      // ── Build one Gemini Batch request per student × subject ────────────────
      // Key format: "<studentId>|<subject>" — used by cron to route results back
      const batchRequests: Array<{ key: string; prompt: string }> = [];

      for (const student of students) {
        for (const subject of subjects) {
          try {
            const weakness = await analyzeStudentWeakness(student.id, subject, schoolId, currentMonth);
            const profileType = weakness.profile_type;
            const weakTopics = weakness.weak_topics.slice(0, 4).map((t) => t.topic);

            let prompt: string;
            if (profileType === 'no_data') {
              prompt = buildPackPromptNoData(className, subject, board);
            } else if (profileType === 'enrichment') {
              prompt = buildPackPromptEnrichment(className, subject, board);
            } else {
              prompt = buildPackPromptWeak(className, subject, board, weakTopics);
            }

            batchRequests.push({ key: `${student.id}|${subject}`, prompt });

            // Pre-create the recovery_pack row as 'processing' so cron can upsert results
            const { data: existing } = await supabaseAdmin
              .from('recovery_packs')
              .select('id')
              .eq('cycle_id', cycleId)
              .eq('student_id', student.id)
              .eq('subject', subject)
              .maybeSingle();

            if (!existing) {
              await supabaseAdmin.from('recovery_packs').insert({
                cycle_id: cycleId,
                student_id: student.id,
                school_id: schoolId,
                subject,
                scheduled_month: currentMonth,
                weak_topics: weakTopics,
                student_profile_type: profileType,
                generation_status: 'processing',
              });
            } else {
              await supabaseAdmin.from('recovery_packs').update({
                weak_topics: weakTopics,
                student_profile_type: profileType,
                generation_status: 'processing',
              }).eq('id', (existing as { id: string }).id);
            }
          } catch (err) {
            console.error(`[recovery/start-pack] weakness analysis failed student=${student.id} subject=${subject}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      if (batchRequests.length === 0) {
        await supabaseAdmin.from('recovery_cycles').update({
          status: 'pack_failed',
          lockout_until: null,
          updated_at: new Date().toISOString(),
        }).eq('id', cycleId);
        return;
      }

      // ── Submit single Batch API job for all students × subjects ─────────────
      const batchJobName = await submitGeminiBatchJob(batchRequests);

      // Store the batch job name on the cycle so the cron can poll it
      await supabaseAdmin.from('recovery_cycles').update({
        pack_batch_job_id: batchJobName,
        updated_at: new Date().toISOString(),
      }).eq('id', cycleId);

      console.log(`[recovery/start-pack] Batch job submitted: ${batchJobName} (${batchRequests.length} requests)`);
    } catch (err) {
      console.error('[recovery/start-pack] Fatal:', err instanceof Error ? err.message : err);
      try {
        await supabaseAdmin.from('recovery_cycles').update({
          status: 'pack_failed',
          lockout_until: null,
          updated_at: new Date().toISOString(),
        }).eq('id', cycleId);
      } catch { /* best-effort */ }
    }
  });
});

// ── POST /api/recovery/start-tests ───────────────────────────────────────────

const subjectConfigSchema = z.object({
  subject:             z.string().min(1),
  time_limit_minutes:  z.number().int().min(1).max(180),
  shuffle_questions:   z.boolean().default(true),
  shuffle_options:     z.boolean().default(true),
  available_from:      z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  available_until:     z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  require_camera:      z.boolean().default(false),
});

const startTestsSchema = z.object({
  cycle_id:       z.string().uuid(),
  subject_configs: z.array(subjectConfigSchema).min(1),
});

router.post('/start-tests', ...teacherAuth, async (req: Request, res: Response) => {
  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id as string;
  if (!schoolId) { sendError(res, 'No school associated with your account', 403); return; }

  const parsed = startTestsSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }
  const { cycle_id: cycleId, subject_configs: subjectConfigs } = parsed.data;

  // Verify cycle belongs to this teacher's school
  const { data: cycle } = await supabaseAdmin
    .from('recovery_cycles')
    .select('id, class, section, status, school_id')
    .eq('id', cycleId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!cycle) { sendError(res, 'Cycle not found', 404); return; }
  const c = cycle as { id: string; class: string; section: string; status: string; school_id: string };

  if (!['pack_ready', 'tests_ready', 'test_failed'].includes(c.status)) {
    sendError(res, `Cannot generate tests for a cycle with status '${c.status}'`, 400);
    return;
  }

  // Update cycle status
  await supabaseAdmin.from('recovery_cycles').update({
    status: 'generating_tests',
    updated_at: new Date().toISOString(),
  }).eq('id', cycleId);

  sendSuccess(res, { cycle_id: cycleId }, 'Recovery test generation started');

  // Submit Gemini Batch API job in background — teacher does not wait for this
  setImmediate(async () => {
    try {
      const students = await getStudentsInClass(schoolId, c.class, c.section);
      const board = await getSchoolBoard(schoolId);

      // ── Build one Gemini Batch request per student × subject ────────────────
      // Key format: "<studentId>|<subject>" — used by cron to route results back
      const batchRequests: Array<{ key: string; prompt: string }> = [];

      for (const config of subjectConfigs) {
        for (const student of students) {
          try {
            // Load this student's recovery PACK content — questions are generated FROM the pack
            const { data: packRow } = await supabaseAdmin
              .from('recovery_packs')
              .select('weak_topics, student_profile_type, pack_content')
              .eq('cycle_id', cycleId)
              .eq('student_id', student.id)
              .eq('subject', config.subject)
              .maybeSingle();

            const pack = packRow as {
              weak_topics: string[] | null;
              student_profile_type: string | null;
              pack_content: unknown | null;
            } | null;

            const topics: string[] = pack?.weak_topics ?? [config.subject];
            const profileType: StudentProfileType = (pack?.student_profile_type as StudentProfileType | null) ?? 'weak';
            const questionCount = Math.min(30, Math.max(20, topics.length * 4));

            // Build prompt using pack content so questions come directly from the pack material
            const prompt = buildTestPromptFromPack(
              c.class,
              config.subject,
              board,
              topics,
              questionCount,
              profileType,
              pack?.pack_content
            );

            batchRequests.push({ key: `${student.id}|${config.subject}`, prompt });

            // Pre-create the test row as 'processing' so cron can upsert results
            const { data: existing } = await supabaseAdmin
              .from('monthly_recovery_tests')
              .select('id')
              .eq('cycle_id', cycleId)
              .eq('student_id', student.id)
              .eq('subject', config.subject)
              .maybeSingle();

            const testPayload = {
              cycle_id: cycleId,
              student_id: student.id,
              school_id: schoolId,
              subject: config.subject,
              scheduled_month: new Date().toISOString().slice(0, 7) + '-01',
              weak_topics_used: topics,
              total_questions: questionCount,
              generation_status: 'processing',
              is_available: false,
              time_limit_minutes: config.time_limit_minutes,
              shuffle_questions: config.shuffle_questions,
              shuffle_options: config.shuffle_options,
              available_from: config.available_from ?? null,
              available_until: config.available_until ?? null,
              require_camera: config.require_camera,
            };

            if (existing) {
              await supabaseAdmin.from('monthly_recovery_tests').update(testPayload).eq('id', (existing as { id: string }).id);
            } else {
              await supabaseAdmin.from('monthly_recovery_tests').insert(testPayload);
            }
          } catch (err) {
            console.error(`[recovery/start-tests] prep failed student=${student.id} subject=${config.subject}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      if (batchRequests.length === 0) {
        await supabaseAdmin.from('recovery_cycles').update({
          status: 'test_failed',
          updated_at: new Date().toISOString(),
        }).eq('id', cycleId);
        return;
      }

      // ── Submit single Batch API job for all students × subjects ─────────────
      const batchJobName = await submitGeminiBatchJob(batchRequests);

      await supabaseAdmin.from('recovery_cycles').update({
        test_batch_job_id: batchJobName,
        updated_at: new Date().toISOString(),
      }).eq('id', cycleId);

      console.log(`[recovery/start-tests] Batch job submitted: ${batchJobName} (${batchRequests.length} requests)`);
    } catch (err) {
      console.error('[recovery/start-tests] Fatal:', err instanceof Error ? err.message : err);
      try {
        await supabaseAdmin.from('recovery_cycles').update({
          status: 'test_failed',
          updated_at: new Date().toISOString(),
        }).eq('id', cycleId);
      } catch { /* best-effort */ }
    }
  });
});

// ── GET /api/recovery/cycle-status ───────────────────────────────────────────

router.get('/cycle-status', ...teacherAuth, async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id as string;
  if (!schoolId) { sendError(res, 'No school associated with your account', 403); return; }

  const className = req.query.class as string | undefined;
  const section   = req.query.section as string | undefined;

  if (!className || !section) {
    sendError(res, 'class and section query params are required', 400);
    return;
  }

  const { data: cycle } = await supabaseAdmin
    .from('recovery_cycles')
    .select('*')
    .eq('school_id', schoolId)
    .eq('class', className)
    .eq('section', section)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cycle) {
    sendSuccess(res, {
      cycle: null,
      pack_progress: { total: 0, completed: 0, failed: 0 },
      test_progress: { total: 0, completed: 0, failed: 0 },
      lockout_until: null,
      days_remaining: 0,
      is_locked: false,
    });
    return;
  }

  const c = cycle as {
    id: string; status: string; lockout_until: string | null;
    pack_generated_at: string | null; test_generated_at: string | null;
    class: string; section: string;
  };

  const now = new Date();
  const locked = c.lockout_until ? new Date(c.lockout_until) > now : false;
  const daysRemaining = c.lockout_until && locked
    ? Math.ceil((new Date(c.lockout_until).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Pack progress
  const { data: packs } = await supabaseAdmin
    .from('recovery_packs')
    .select('generation_status')
    .eq('cycle_id', c.id);

  const packRows = (packs ?? []) as Array<{ generation_status: string }>;
  const packProgress = {
    total: packRows.length,
    completed: packRows.filter((r) => r.generation_status === 'completed').length,
    failed: packRows.filter((r) => r.generation_status === 'failed').length,
  };

  // Test progress
  const { data: tests } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('generation_status')
    .eq('cycle_id', c.id);

  const testRows = (tests ?? []) as Array<{ generation_status: string }>;
  const testProgress = {
    total: testRows.length,
    completed: testRows.filter((r) => r.generation_status === 'completed').length,
    failed: testRows.filter((r) => r.generation_status === 'failed').length,
  };

  sendSuccess(res, {
    cycle: c,
    pack_progress: packProgress,
    test_progress: testProgress,
    lockout_until: c.lockout_until,
    days_remaining: daysRemaining,
    is_locked: locked,
  });
});

// ── GET /api/recovery/test-results ───────────────────────────────────────────

router.get('/test-results', ...teacherAuth, async (req: Request, res: Response) => {
  const schoolId = req.user!.school_id as string;
  if (!schoolId) { sendError(res, 'No school associated with your account', 403); return; }

  const cycleId = req.query.cycle_id as string | undefined;
  const subject = req.query.subject as string | undefined;

  if (!cycleId || !subject) {
    sendError(res, 'cycle_id and subject query params are required', 400);
    return;
  }

  // Get all tests for this cycle+subject
  const { data: tests } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, student_id')
    .eq('cycle_id', cycleId)
    .eq('subject', subject);

  const testRows = (tests ?? []) as Array<{ id: string; student_id: string }>;

  if (testRows.length === 0) {
    sendSuccess(res, []);
    return;
  }

  const testIds = testRows.map((t) => t.id);
  const studentIds = testRows.map((t) => t.student_id);

  // Fetch student names
  const { data: studentData } = await supabaseAdmin
    .from('students')
    .select('id, full_name')
    .in('id', studentIds);

  const studentMap = new Map<string, string>(
    ((studentData ?? []) as Array<{ id: string; full_name: string }>).map((s) => [s.id, s.full_name])
  );

  // Fetch submitted attempts
  const { data: attempts } = await supabaseAdmin
    .from('recovery_test_attempts')
    .select('recovery_test_id, student_id, score, total_questions, percentage, submitted_at, status')
    .in('recovery_test_id', testIds)
    .eq('status', 'submitted');

  const attemptMap = new Map<string, {
    score: number | null; total_questions: number | null;
    percentage: number | null; submitted_at: string | null;
  }>(
    ((attempts ?? []) as Array<{
      recovery_test_id: string; student_id: string;
      score: number | null; total_questions: number | null;
      percentage: number | null; submitted_at: string | null;
    }>).map((a) => [a.student_id, a])
  );

  const results = testRows.map((t) => {
    const attempt = attemptMap.get(t.student_id);
    return {
      student_id: t.student_id,
      full_name: studentMap.get(t.student_id) ?? 'Unknown',
      score: attempt?.score ?? null,
      total_questions: attempt?.total_questions ?? null,
      percentage: attempt?.percentage ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      status: attempt ? 'submitted' : 'not_given',
    };
  });

  // Sort: not_given first, then by percentage ascending
  results.sort((a, b) => {
    if (a.status === 'not_given' && b.status !== 'not_given') return -1;
    if (a.status !== 'not_given' && b.status === 'not_given') return 1;
    return (a.percentage ?? 0) - (b.percentage ?? 0);
  });

  sendSuccess(res, results);
});

// ── POST /api/recovery/attempt/start ─────────────────────────────────────────

const startAttemptSchema = z.object({ recovery_test_id: z.string().uuid() });

router.post('/attempt/start', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const studentId = req.student!.id;

  const parsed = startAttemptSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }
  const { recovery_test_id } = parsed.data;

  // Verify test exists and belongs to this student
  const { data: test } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('id, subject, questions, total_questions, time_limit_minutes, shuffle_questions, shuffle_options, cycle_id')
    .eq('id', recovery_test_id)
    .eq('student_id', studentId)
    .eq('is_available', true)
    .maybeSingle();

  if (!test) { sendError(res, 'Test not found or not available', 404); return; }

  const t = test as {
    id: string; subject: string;
    questions: Array<{ question: string; options: string[]; correct_index: number; explanation: string; reasoning: string; difficulty: string; topic: string }> | null;
    total_questions: number | null;
    time_limit_minutes: number | null;
    shuffle_questions: boolean;
    shuffle_options: boolean;
    cycle_id: string | null;
  };

  // Prevent re-taking a submitted test
  const { data: existing } = await supabaseAdmin
    .from('recovery_test_attempts')
    .select('id, status')
    .eq('recovery_test_id', recovery_test_id)
    .eq('student_id', studentId)
    .maybeSingle();

  if (existing && (existing as { status: string }).status === 'submitted') {
    sendError(res, 'You have already submitted this test', 409);
    return;
  }

  // Create or reuse in_progress attempt
  let attemptId: string;
  if (existing) {
    attemptId = (existing as { id: string }).id;
  } else {
    const { data: inserted } = await supabaseAdmin
      .from('recovery_test_attempts')
      .insert({
        recovery_test_id,
        student_id: studentId,
        cycle_id: t.cycle_id,
        subject: t.subject,
        status: 'in_progress',
        total_questions: t.total_questions,
      })
      .select('id')
      .single();
    if (!inserted) { sendError(res, 'Failed to create attempt', 500); return; }
    attemptId = (inserted as { id: string }).id;
  }

  // Build original questions with their DB indices
  const originalQuestions = (t.questions ?? []).map((q, i) => ({ ...q, _db_index: i }));

  // Shuffle question order (track mapping: display_position → db_index)
  let orderedQuestions = [...originalQuestions];
  if (t.shuffle_questions) orderedQuestions = orderedQuestions.sort(() => Math.random() - 0.5);

  // For each question, optionally shuffle options (track mapping: display_option_pos → original_pos)
  // option_maps[display_pos_i][display_option_j] = original_option_index
  const optionMaps: number[][] = [];
  const clientQuestions = orderedQuestions.map((q, displayIdx) => {
    const { correct_index: _ci, _db_index, ...rest } = q;
    if (t.shuffle_options) {
      const optionOrder = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      optionMaps[displayIdx] = optionOrder;
      return { ...rest, options: optionOrder.map((oi) => q.options[oi]) };
    }
    optionMaps[displayIdx] = [0, 1, 2, 3]; // identity mapping
    return rest;
  });

  // Persist the shuffle maps into the attempt row so submit can grade correctly
  const questionDbIndices = orderedQuestions.map((q) => q._db_index);
  await supabaseAdmin.from('recovery_test_attempts').update({
    answers: {
      _shuffle_meta: { question_db_indices: questionDbIndices, option_maps: optionMaps },
    },
  }).eq('id', attemptId);

  sendSuccess(res, {
    attempt_id: attemptId,
    time_limit_minutes: t.time_limit_minutes,
    questions: clientQuestions,
  });
});

// ── POST /api/recovery/attempt/submit ─────────────────────────────────────────

const submitAttemptSchema = z.object({
  attempt_id: z.string().uuid(),
  answers: z.array(z.object({
    question_id: z.string(),
    selected_option: z.enum(['a', 'b', 'c', 'd']).optional(),
  })),
});

router.post('/attempt/submit', authenticateStudent, requireRole('student'), async (req: Request, res: Response) => {
  const studentId = req.student!.id;

  const parsed = submitAttemptSchema.safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error.flatten()); return; }
  const { attempt_id: attemptId, answers } = parsed.data;

  // Fetch attempt
  const { data: attempt } = await supabaseAdmin
    .from('recovery_test_attempts')
    .select('id, student_id, recovery_test_id, status')
    .eq('id', attemptId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (!attempt) { sendError(res, 'Attempt not found', 404); return; }
  const a = attempt as { id: string; student_id: string; recovery_test_id: string; status: string };
  if (a.status === 'submitted') { sendError(res, 'Test already submitted', 409); return; }

  // Fetch full test with correct answers
  const { data: test } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .select('questions, total_questions')
    .eq('id', a.recovery_test_id)
    .maybeSingle();

  if (!test) { sendError(res, 'Test not found', 404); return; }
  const t = test as {
    questions: Array<{ question: string; options: string[]; correct_index: number; topic: string }> | null;
    total_questions: number | null;
  };

  const questions = t.questions ?? [];

  // Retrieve the shuffle maps stored when the attempt was started
  const { data: attemptMeta } = await supabaseAdmin
    .from('recovery_test_attempts')
    .select('answers')
    .eq('id', attemptId)
    .maybeSingle();

  type ShuffleMeta = { question_db_indices: number[]; option_maps: number[][] };
  const storedAnswers = (attemptMeta as { answers?: { _shuffle_meta?: ShuffleMeta } } | null)?.answers;
  const shuffleMeta: ShuffleMeta | undefined = storedAnswers?._shuffle_meta;

  const optionKeyToIndex: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };

  // Grade each answer using the shuffle maps so shuffled questions/options score correctly
  let score = 0;
  const answersPayload = answers.map((ans, displayPos) => {
    // Which DB question does this display position correspond to?
    const dbIndex = shuffleMeta ? (shuffleMeta.question_db_indices[displayPos] ?? displayPos) : displayPos;
    const q = questions[dbIndex];
    if (!q) return { question_index: dbIndex, selected_option: ans.selected_option ?? null, is_correct: false };

    let selectedDbOptionIndex: number | null = null;
    if (ans.selected_option) {
      const displayOptionIndex = optionKeyToIndex[ans.selected_option]; // 0-3 in shuffled order
      // Map display option index back to the original DB option index
      const optionMap = shuffleMeta ? shuffleMeta.option_maps[displayPos] : null;
      selectedDbOptionIndex = optionMap ? (optionMap[displayOptionIndex] ?? displayOptionIndex) : displayOptionIndex;
    }

    const isCorrect = selectedDbOptionIndex !== null && selectedDbOptionIndex === q.correct_index;
    if (isCorrect) score++;
    return { question_index: dbIndex, selected_option: ans.selected_option ?? null, is_correct: isCorrect };
  });

  const total = questions.length;
  const percentage = total > 0 ? parseFloat(((score / total) * 100).toFixed(2)) : 0;

  await supabaseAdmin.from('recovery_test_attempts').update({
    score,
    total_questions: total,
    percentage,
    answers: answersPayload,
    status: 'submitted',
    submitted_at: new Date().toISOString(),
  }).eq('id', attemptId);

  sendSuccess(res, { attempt_id: attemptId, score, total_questions: total, percentage });
});

export default router;
