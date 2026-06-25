/**
 * weeklyAnalysisService.ts
 *
 * Sunday scheduled job that:
 *   1. Calculates weakness_score per student/subject/topic and upserts into weak_topics
 *   2. Calls Gemini (model from GEMINI_MODEL env var) to generate a parent-friendly weekly report
 *   3. Stores the report in weekly_reports table
 *   4. Sends FCM push notification to the parent
 *
 * Triggered by:
 *   POST /api/weekly-analysis/run  (secret-guarded cron endpoint on Railway)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabaseAdmin } from '../config/supabase';
import { getTokensForUsers } from './fcmService';
import { sendPushMulticast } from './fcmService';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentRecord {
  id: string;
  full_name: string;
  class_name: string;
  class: string;
  school_id: string;
  parent_id: string | null;
  board?: string;
}

interface MarkRow {
  subject: string;
  score: number;
  max_score: number;
  exam_type: string;
  created_at: string;
}

interface DailyTestScore {
  topic: string;
  subject: string;
  score: number;
  total_questions: number;
  completed_at: string;
}

interface ActivityCompletion {
  subject: string;
  topic: string;
  completed_at: string;
}

interface WeakTopicRow {
  subject: string;
  topic: string;
  weakness_score: number;
}

interface AttendanceRow {
  status: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the Monday-based week start (Sunday) as YYYY-MM-DD. */
export function getLastSunday(): string {
  const d = new Date();
  // Go back to most recent Sunday (day 0)
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

/** Extract numeric class level from class_name string. */
function parseClassLevel(className: string): number {
  const match = className.replace(/[^0-9]/g, '');
  return parseInt(match, 10) || 0;
}

/**
 * Calculate weakness score (0-100) for a topic.
 *
 * Logic:
 *   - Pull daily test scores for the topic: average score %
 *   - Pull marks for the subject: trend-adjusted average %
 *   - Combine: 60% weight on daily test avg, 40% on marks avg
 *   - weakness_score = 100 - combined_avg  (higher = weaker)
 *
 * @param dailyTestAvgPct  0–100 average score percentage from daily tests for this topic
 * @param marksAvgPct      0–100 average score percentage from marks table for this subject
 * @returns weakness_score 0–100
 */
function calcWeaknessScore(
  dailyTestAvgPct: number | null,
  marksAvgPct: number | null
): number {
  let combined: number;

  if (dailyTestAvgPct !== null && marksAvgPct !== null) {
    combined = dailyTestAvgPct * 0.6 + marksAvgPct * 0.4;
  } else if (dailyTestAvgPct !== null) {
    combined = dailyTestAvgPct;
  } else if (marksAvgPct !== null) {
    combined = marksAvgPct;
  } else {
    return 50; // No data — neutral score
  }

  const score = Math.round(100 - combined);
  return Math.max(0, Math.min(100, score));
}

// ── Step 1: Calculate and upsert weak topics ──────────────────────────────────

export async function calculateWeakTopics(studentId: string, classLevel: number): Promise<WeakTopicRow[]> {
  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1a. Fetch marks grouped by subject (all time for trend, last 90 days for recency)
  const { data: marks } = await supabaseAdmin
    .from('marks')
    .select('subject, score, max_score, exam_type, created_at')
    .eq('student_id', studentId)
    .order('created_at', { ascending: true });

  const markRows: MarkRow[] = (marks ?? []).map((m: Record<string, unknown>) => ({
    subject: m.subject as string,
    score: Number(m.score),
    max_score: Number(m.max_score) || 100,
    exam_type: m.exam_type as string,
    created_at: m.created_at as string,
  }));

  // Build subject → marks average map
  const subjectMarksMap = new Map<string, number[]>();
  for (const m of markRows) {
    if (!subjectMarksMap.has(m.subject)) subjectMarksMap.set(m.subject, []);
    subjectMarksMap.get(m.subject)!.push((m.score / m.max_score) * 100);
  }

  // 1b. Fetch test_attempt scores joined with tests for per-topic/subject weakness
  //     Uses the marks table (auto-written on submit) for class 7-12
  const topicScoresMap = new Map<string, { subject: string; scores: number[] }>();

  if (classLevel >= 7) {
    // Pull from marks table — auto-written notes tag: "auto:attempt:<attempt_id>"
    // We already have markRows from above which includes all test scores.
    // Build topic map from subject-level marks (best available without daily_tests table)
    for (const [subject, pcts] of subjectMarksMap.entries()) {
      const key = `${subject}::${subject}`;
      if (!topicScoresMap.has(key)) {
        topicScoresMap.set(key, { subject, scores: [] });
      }
      topicScoresMap.get(key)!.scores.push(...pcts);
    }
  }

  // 1c. Build weak_topics rows to upsert
  const weakTopicsToUpsert: Array<{
    student_id: string;
    subject: string;
    topic: string;
    weakness_score: number;
    last_calculated_at: string;
  }> = [];

  // From daily test attempts (classes 7-12)
  for (const [key, { subject, scores }] of topicScoresMap.entries()) {
    const avgPct = scores.reduce((a, b) => a + b, 0) / scores.length;
    const subjectMarks = subjectMarksMap.get(subject);
    const marksAvg = subjectMarks
      ? subjectMarks.reduce((a, b) => a + b, 0) / subjectMarks.length
      : null;

    const weaknessScore = calcWeaknessScore(avgPct, marksAvg);
    const [, topic] = key.split('::');

    weakTopicsToUpsert.push({
      student_id: studentId,
      subject,
      topic,
      weakness_score: weaknessScore,
      last_calculated_at: now,
    });
  }

  // From marks only (for subjects without daily tests, use subject as topic)
  for (const [subject, pcts] of subjectMarksMap.entries()) {
    // Only add if no topic-level entry exists for this subject
    const hasTopicEntry = weakTopicsToUpsert.some((w) => w.subject === subject);
    if (!hasTopicEntry && classLevel >= 7) continue; // Classes 7-12: skip — covered by topic entries
    if (classLevel < 7) {
      // Classes 1-6: use subject as topic
      const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      const weaknessScore = calcWeaknessScore(null, avgPct);
      weakTopicsToUpsert.push({
        student_id: studentId,
        subject,
        topic: subject, // topic = subject for junior classes
        weakness_score: weaknessScore,
        last_calculated_at: now,
      });
    }
  }

  // 1d. Upsert into weak_topics
  if (weakTopicsToUpsert.length > 0) {
    const { error: upsertErr } = await supabaseAdmin
      .from('weak_topics')
      .upsert(weakTopicsToUpsert, {
        onConflict: 'student_id,subject,topic',
        ignoreDuplicates: false,
      });

    if (upsertErr) {
      console.error('[weeklyAnalysis] weak_topics upsert error:', upsertErr.message);
    }
  }

  return weakTopicsToUpsert.map((w) => ({
    subject: w.subject,
    topic: w.topic,
    weakness_score: w.weakness_score,
  }));
}

// ── Step 2: Generate AI weekly report ─────────────────────────────────────────

export async function generateWeeklyReport(
  student: StudentRecord,
  weekStartDate: string
): Promise<string> {
  const classLevel = parseClassLevel(student.class_name || student.class || '1');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Fetch all data in parallel
  const [marksRes, weakTopicsRes, streakRes, attendanceRes, activityRes] =
    await Promise.all([
      // Marks history (last 6 months)
      supabaseAdmin
        .from('marks')
        .select('subject, score, max_score, exam_type, created_at')
        .eq('student_id', student.id)
        .gte('created_at', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(30),

      // Weak topics
      supabaseAdmin
        .from('weak_topics')
        .select('subject, topic, weakness_score')
        .eq('student_id', student.id)
        .order('weakness_score', { ascending: false })
        .limit(10),

      // Current streak
      supabaseAdmin
        .from('student_streaks')
        .select('current_streak, longest_streak, total_active_days')
        .eq('student_id', student.id)
        .maybeSingle(),

      // Attendance last 30 days
      supabaseAdmin
        .from('attendance')
        .select('status')
        .eq('student_id', student.id)
        .gte('date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)),

      // Activity completions last 7 days (classes 1-6)
      classLevel < 7
        ? supabaseAdmin
            .from('activity_completions')
            .select('completed_at, activity_packs(subject, topic)')
            .eq('student_id', student.id)
            .eq('parent_marked_complete', true)
            .gte('completed_at', weekAgo)
            .limit(20)
        : Promise.resolve({ data: [] }),
    ]);

  // Process marks data
  const marksData = (marksRes.data ?? []).map((m: Record<string, unknown>) => ({
    subject: m.subject,
    score: Number(m.score),
    max_score: Number(m.max_score) || 100,
    pct: Math.round((Number(m.score) / (Number(m.max_score) || 100)) * 100),
    exam_type: m.exam_type,
    date: (m.created_at as string).slice(0, 10),
  }));

  // Process weak topics
  const weakTopics = (weakTopicsRes.data ?? []) as WeakTopicRow[];

  // Process streak
  const streak = streakRes.data as { current_streak: number; longest_streak: number; total_active_days: number } | null;
  const streakDays = streak?.current_streak ?? 0;

  // Process attendance
  const attRecords = (attendanceRes.data ?? []) as AttendanceRow[];
  const totalDays = attRecords.length;
  const presentDays = attRecords.filter((r) => r.status === 'present' || r.status === 'late').length;
  const attendancePct = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

  // Process daily test scores — now pulled from recent marks records instead
  const recentTestMarks = marksData.filter((m) => m.exam_type === 'class_test' || m.exam_type === 'quiz' || m.exam_type === 'unit_test');

  // Process activity completions
  const activityData = (activityRes.data ?? []).map((ac: Record<string, unknown>) => {
    const ap = ac.activity_packs as Record<string, unknown> | null;
    return {
      subject: ap?.subject ?? 'General',
      topic: ap?.topic ?? 'Activity',
    };
  });

  const board = student.board ?? 'CBSE';

  // Build Gemini prompt
  const prompt = `You are an academic advisor for a Class ${classLevel} student in India (${board} curriculum).
Marks history (last 6 months): ${JSON.stringify(marksData.slice(0, 15))}
Weak topics: ${JSON.stringify(weakTopics.slice(0, 8))}
Recent test scores (last 7 days): ${JSON.stringify(recentTestMarks.slice(0, 10))}
Activity completion (if class 1-6): ${JSON.stringify(activityData)}
Current streak: ${streakDays} days
Attendance %: ${attendancePct}%

Write a parent-friendly weekly summary (max 150 words, simple English with occasional Hindi/Gujarati words parents understand):
1. One-line overall summary
2. Strongest area this week
3. Area needing attention with ONE specific suggestion
4. Streak encouragement if streak > 3 days
5. Warm closing line

Avoid generic phrases. Be specific using the actual data. Do not use bullet points — write in flowing paragraphs.
Return as JSON: {"report_text": "<your summary here>"}`;

  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
    if (!apiKey) throw new Error('Gemini API key not configured');

    const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

    // Structured output schema — weekly report is a single text field
    const responseSchema = {
      type: 'object' as const,
      properties: {
        report_text: { type: 'string' as const },
      },
      required: ['report_text'],
    };

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
        // Disable thinking tokens — weekly report is a 150-word summary from
        // pre-computed data. Thinking mode adds 8k–20k tokens per student call.
        thinkingConfig: { thinkingBudget: 0 },
      } as Record<string, unknown>,
    });

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    let parsed: { report_text: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: treat the whole response as the report text
      parsed = { report_text: raw };
    }

    const text = parsed.report_text?.trim() ?? raw;

    // Trim to 150 words approximately (safety net)
    const words = text.split(/\s+/);
    if (words.length > 200) {
      return words.slice(0, 200).join(' ') + '...';
    }
    return text;
  } catch (err) {
    console.error('[weeklyAnalysis] Gemini error for student', student.id, err);
    // Return a fallback message instead of failing the whole job
    return `This week's performance summary for your child (Class ${classLevel}) is being prepared. Attendance: ${attendancePct}%. Current study streak: ${streakDays} days. Please check the app for detailed subject-wise progress. Keep encouraging your child — har din thodi mehnat kaafi hoti hai! 🌟`;
  }
}

// ── Step 3: Store report and send FCM ─────────────────────────────────────────

async function storeReportAndNotify(
  student: StudentRecord,
  weekStartDate: string,
  reportText: string
): Promise<void> {
  // Upsert weekly report
  const { error: insertErr } = await supabaseAdmin
    .from('weekly_reports')
    .upsert(
      {
        student_id: student.id,
        week_start_date: weekStartDate,
        report_text: reportText,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'student_id,week_start_date' }
    );

  if (insertErr) {
    console.error('[weeklyAnalysis] weekly_reports upsert error:', insertErr.message);
  }

  // Send FCM to parent
  if (student.parent_id) {
    try {
      const tokens = await getTokensForUsers([student.parent_id]);
      if (tokens.length > 0) {
        await sendPushMulticast(
          tokens,
          "📊 Weekly Success Report Ready!",
          `Your child's weekly performance report for ${student.full_name} is ready. Tap to view their progress!`,
          { type: 'weekly_report', student_id: student.id, week_start_date: weekStartDate }
        );
      }
    } catch (fcmErr) {
      console.error('[weeklyAnalysis] FCM error for student', student.id, fcmErr);
    }
  }
}

// ── Main job runner ───────────────────────────────────────────────────────────

export interface WeeklyAnalysisResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ student_id: string; error: string }>;
}

export async function runWeeklyAnalysis(): Promise<WeeklyAnalysisResult> {
  const weekStartDate = getLastSunday();
  console.log(`[weeklyAnalysis] Starting weekly analysis for week: ${weekStartDate}`);

  const result: WeeklyAnalysisResult = {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Fetch all active (non-deleted) students
  const { data: studentRows, error: studErr } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, class, school_id, parent_id')
    .eq('is_deleted', false);

  if (studErr) {
    console.error('[weeklyAnalysis] Failed to fetch students:', studErr.message);
    throw new Error('Failed to fetch students: ' + studErr.message);
  }

  const students: StudentRecord[] = (studentRows ?? []).map((s) => {
    const row = s as Record<string, unknown>;
    return {
      id: row.id as string,
      full_name: row.full_name as string,
      class_name: (row.class_name as string) ?? '',
      class: (row.class as string) ?? '',
      school_id: row.school_id as string,
      parent_id: row.parent_id as string | null,
    };
  });

  result.total = students.length;
  console.log(`[weeklyAnalysis] Processing ${result.total} students`);

  // Process each student sequentially to avoid rate limiting Gemini
  for (const student of students) {
    try {
      const classLevel = parseClassLevel(student.class_name || student.class || '1');

      // Step 1: Calculate and upsert weak topics
      await calculateWeakTopics(student.id, classLevel);

      // Step 2: Generate AI weekly report
      const reportText = await generateWeeklyReport(student, weekStartDate);

      // Step 3: Store and notify
      await storeReportAndNotify(student, weekStartDate, reportText);

      result.succeeded++;
      console.log(`[weeklyAnalysis] ✓ Student ${student.id} (${student.full_name})`);

      // Small delay to respect Gemini rate limits
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      result.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ student_id: student.id, error: errMsg });
      console.error(`[weeklyAnalysis] ✗ Student ${student.id}:`, errMsg);
    }
  }

  console.log(
    `[weeklyAnalysis] Done. Success: ${result.succeeded}, Failed: ${result.failed}, Skipped: ${result.skipped}`
  );
  return result;
}
