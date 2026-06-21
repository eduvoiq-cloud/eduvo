/**
 * monthlyReportService.ts
 *
 * Generates monthly academic reports for students:
 *   A. getStudentMonthlyData   — aggregates data for one student over the past 28-31 days
 *   B. generateMonthlyReport   — calls Gemini to produce a structured multilingual report
 *   C. assembleWhatsAppMessage — formats the WhatsApp-ready text
 *   D. saveAndSendReport       — upserts into monthly_reports, optionally sends WhatsApp
 *   E. submitGeminiBatch /
 *      checkGeminiBatch        — Gemini Batch API support (off by default)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabaseAdmin } from '../config/supabase';
import { sendWhatsAppMessage } from './whatsappService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StudentMonthlyData {
  studentId: string;
  studentName: string;
  class: string;
  parentPhone: string | null;
  marksBySubject: Record<string, number>; // subject -> average percentage
  attendancePresent: number;
  attendanceTotal: number;
  attendancePct: number;
  currentStreak: number;
  weakTopics: string[];
  bestSubject: string | null;
  bestScore: number | null;
  weakSubject: string | null;   // single worst subject (for backward compat)
  weakScore: number | null;
  weakSubjects: Array<{ subject: string; score: number }>; // ALL subjects below 70%, sorted worst-first
  // Homework
  homeworkAssigned: number;
  homeworkSubmitted: number;
  homeworkNotSubmitted: number;
  homeworkFlaggedCount: number;          // AI flagged suspicious submissions
  // Tests
  testsScheduled: number;
  testsAttempted: number;
  testsMissed: number;
  // Integrity / suspicious activity
  suspiciousTestCount: number;           // tests where is_suspicious = true
  suspiciousReasons: string[];           // aggregated unique reasons
}

export interface MonthlyReportContent {
  structured_lines: {
    overall: string;
    best_subject: string | null;
    best_score: number | null;
    weak_subject: string | null;   // single worst subject (backward compat)
    weak_score: number | null;
    weak_subjects: Array<{ subject: string; score: number }> | null; // ALL subjects below 70%
    attendance_pct: number;
    attendance_present: number;
    attendance_total: number;
    streak_days: number;
    homework_submitted: number;
    homework_assigned: number;
    tests_missed: number;
    suspicious_test_count: number;
    tip: string;
  };
  summary_en: string;
  summary_hi: string;
  summary_gu: string;
}

// ── PART A — Data Aggregation ─────────────────────────────────────────────────

/**
 * Fetches and aggregates all data for one student covering the 28-31 days
 * starting from monthStartDate.
 */
export async function getStudentMonthlyData(
  studentId: string,
  monthStartDate: Date
): Promise<StudentMonthlyData> {
  // Calculate end of period: 31 days after start
  const periodEnd = new Date(monthStartDate);
  periodEnd.setDate(periodEnd.getDate() + 31);

  const startIso = monthStartDate.toISOString().slice(0, 10);
  const endIso   = periodEnd.toISOString().slice(0, 10);

  // Fetch all data in parallel
  const [
    studentRes,
    marksRes,
    attendanceRes,
    weakTopicsRes,
    streakRes,
    homeworkAssignedRes,
    homeworkSubmissionsRes,
    testAttemptsRes,
    integrityRes,
  ] = await Promise.all([
      // Student record — name, class, parent_phone
      supabaseAdmin
        .from('students')
        .select('full_name, class_name, class, parent_phone, section')
        .eq('id', studentId)
        .maybeSingle(),

      // Marks in the period
      supabaseAdmin
        .from('marks')
        .select('subject, score, max_score')
        .eq('student_id', studentId)
        .gte('created_at', monthStartDate.toISOString())
        .lte('created_at', periodEnd.toISOString()),

      // Attendance in the period
      supabaseAdmin
        .from('attendance')
        .select('status')
        .eq('student_id', studentId)
        .gte('date', startIso)
        .lte('date', endIso),

      // Current weak topics
      supabaseAdmin
        .from('weak_topics')
        .select('topic, weakness_score')
        .eq('student_id', studentId)
        .order('weakness_score', { ascending: false })
        .limit(10),

      // Streak
      supabaseAdmin
        .from('student_streaks')
        .select('current_streak, longest_streak')
        .eq('student_id', studentId)
        .maybeSingle(),

      // We'll fetch homework assigned for this student's class+section after
      // we know their class — done below after student row is fetched.
      // Placeholder: fetch student row first, then homework.
      Promise.resolve({ data: null, error: null }),

      // Homework submissions by this student in the period
      supabaseAdmin
        .from('homework_submissions')
        .select('status, ai_result, flagged_reason, submitted_at')
        .eq('student_id', studentId)
        .gte('submitted_at', monthStartDate.toISOString())
        .lte('submitted_at', periodEnd.toISOString()),

      // Tests this student attempted in the period
      supabaseAdmin
        .from('test_attempts')
        .select('id, test_id, is_submitted, submitted_at')
        .eq('student_id', studentId)
        .gte('started_at', monthStartDate.toISOString())
        .lte('started_at', periodEnd.toISOString()),

      // Integrity logs for this student in the period — suspicious tests
      supabaseAdmin
        .from('test_integrity_logs')
        .select('is_suspicious, suspicious_reasons')
        .eq('student_id', studentId)
        .eq('is_suspicious', true)
        .gte('created_at', monthStartDate.toISOString())
        .lte('created_at', periodEnd.toISOString()),
    ]);

  // ── Student info ──────────────────────────────────────────────────────────
  const studentRow = studentRes.data as Record<string, unknown> | null;
  const studentName = (studentRow?.full_name as string) ?? 'Unknown';
  const studentClass =
    (studentRow?.class_name as string) ?? (studentRow?.class as string) ?? '';
  const studentSection = (studentRow?.section as string) ?? '';
  const parentPhone = (studentRow?.parent_phone as string) ?? null;

  // ── Marks: build subject -> average percentage map ────────────────────────
  const subjectScores = new Map<string, number[]>();

  for (const row of marksRes.data ?? []) {
    const m = row as Record<string, unknown>;
    const subject  = m.subject as string;
    const score    = Number(m.score);
    const maxScore = Number(m.max_score) || 100;
    const pct      = (score / maxScore) * 100;

    if (!subjectScores.has(subject)) subjectScores.set(subject, []);
    subjectScores.get(subject)!.push(pct);
  }

  const marksBySubject: Record<string, number> = {};
  for (const [subject, scores] of subjectScores.entries()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    marksBySubject[subject] = Math.round(avg * 10) / 10; // 1 decimal place
  }

  // ── Best / weak subject calculation ──────────────────────────────────────
  // Only consider subjects with at least 2 marks entries
  let bestSubject: string | null = null;
  let bestScore: number | null   = null;
  let weakSubject: string | null = null;
  let weakScore: number | null   = null;
  const weakSubjects: Array<{ subject: string; score: number }> = [];

  for (const [subject, scores] of subjectScores.entries()) {
    if (scores.length < 2) continue;

    const avg = marksBySubject[subject];

    // Best: highest average
    if (bestScore === null || avg > bestScore) {
      bestScore   = avg;
      bestSubject = subject;
    }

    // Collect ALL subjects below 70%
    if (avg < 70) {
      weakSubjects.push({ subject, score: avg });
      // Weak (single worst): lowest average below 70%
      if (weakScore === null || avg < weakScore) {
        weakScore   = avg;
        weakSubject = subject;
      }
    }
  }

  // Sort weak subjects worst-first
  weakSubjects.sort((a, b) => a.score - b.score);

  // ── Attendance ────────────────────────────────────────────────────────────
  const attRows     = (attendanceRes.data ?? []) as Array<Record<string, unknown>>;
  const attTotal    = attRows.length;
  const attPresent  = attRows.filter(
    (r) => r.status === 'present' || r.status === 'late'
  ).length;
  const attPct      =
    attTotal > 0 ? Math.round((attPresent / attTotal) * 100) : 0;

  // ── Weak topics ───────────────────────────────────────────────────────────
  const weakTopicsList = (weakTopicsRes.data ?? []).map(
    (r: Record<string, unknown>) => r.topic as string
  );

  // ── Streak ────────────────────────────────────────────────────────────────
  const streakRow    = streakRes.data as Record<string, unknown> | null;
  const currentStreak = Number(streakRow?.current_streak ?? 0);

  // ── Homework assigned vs submitted ────────────────────────────────────────
  // Fetch homework assigned to this student's class+section in the period
  let homeworkAssigned = 0;
  if (studentClass) {
    const { data: hwRows } = await supabaseAdmin
      .from('homework')
      .select('id')
      .eq('class_name', studentClass)
      .eq('section', studentSection)
      .gte('due_date', startIso)
      .lte('due_date', endIso);
    homeworkAssigned = (hwRows ?? []).length;
  }

  const hwSubmissions = (homeworkSubmissionsRes.data ?? []) as Array<Record<string, unknown>>;
  const homeworkSubmitted = hwSubmissions.filter(
    (r) => r.status !== 'not_submitted'
  ).length;
  const homeworkNotSubmitted = Math.max(0, homeworkAssigned - homeworkSubmitted);
  const homeworkFlaggedCount = hwSubmissions.filter(
    (r) => r.status === 'flagged_for_review' || r.flagged_reason != null
  ).length;

  // ── Tests scheduled vs attempted ─────────────────────────────────────────
  let testsScheduled = 0;
  if (studentClass) {
    const { data: testRows } = await supabaseAdmin
      .from('tests')
      .select('id')
      .eq('class', studentClass)
      .eq('section', studentSection)
      .gte('date', startIso)
      .lte('date', endIso);
    testsScheduled = (testRows ?? []).length;
  }

  const attempts = (testAttemptsRes.data ?? []) as Array<Record<string, unknown>>;
  const testsAttempted = attempts.filter((r) => r.is_submitted === true).length;
  const testsMissed = Math.max(0, testsScheduled - testsAttempted);

  // ── Integrity / suspicious activity ──────────────────────────────────────
  const integrityRows = (integrityRes.data ?? []) as Array<Record<string, unknown>>;
  const suspiciousTestCount = integrityRows.length;
  const suspiciousReasons = [
    ...new Set(
      integrityRows.flatMap(
        (r) => (r.suspicious_reasons as string[] | null) ?? []
      )
    ),
  ];

  return {
    studentId,
    studentName,
    class: studentClass,
    parentPhone,
    marksBySubject,
    attendancePresent: attPresent,
    attendanceTotal:   attTotal,
    attendancePct:     attPct,
    currentStreak,
    weakTopics: weakTopicsList,
    bestSubject,
    bestScore:  bestScore !== null ? Math.round(bestScore * 10) / 10 : null,
    weakSubject,
    weakScore:  weakScore !== null ? Math.round(weakScore * 10) / 10 : null,
    weakSubjects: weakSubjects.map((w) => ({ subject: w.subject, score: Math.round(w.score * 10) / 10 })),
    homeworkAssigned,
    homeworkSubmitted,
    homeworkNotSubmitted,
    homeworkFlaggedCount,
    testsScheduled,
    testsAttempted,
    testsMissed,
    suspiciousTestCount,
    suspiciousReasons,
  };
}

// ── PART B — Gemini Report Generation ────────────────────────────────────────

/**
 * Calls Gemini to produce a structured multilingual monthly report.
 */
export async function generateMonthlyReport(
  data: StudentMonthlyData,
  monthLabel: string
): Promise<MonthlyReportContent> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
  if (!apiKey) throw new Error('[Monthly] Gemini API key not configured');

  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const weakTopicsStr =
    data.weakTopics.length > 0 ? data.weakTopics.join(', ') : 'none identified';

  const bestSubjectStr =
    data.bestSubject !== null
      ? `${data.bestSubject} (${data.bestScore}%)`
      : 'N/A';

  const weakSubjectStr =
    data.weakSubject !== null
      ? `${data.weakSubject} (${data.weakScore}%)`
      : 'null (all subjects above 70%)';

  const allWeakSubjectsStr =
    data.weakSubjects.length > 0
      ? data.weakSubjects.map((w) => `${w.subject} (${w.score}%)`).join(', ')
      : 'none (all subjects ≥ 70%)';

  const suspiciousStr =
    data.suspiciousTestCount > 0
      ? `${data.suspiciousTestCount} test(s) flagged (reasons: ${data.suspiciousReasons.join(', ') || 'unspecified'})`
      : 'none';

  const prompt = `You are generating a monthly academic report for an Indian school student.
Student: ${data.studentName}
Class: ${data.class}
Month: ${monthLabel}

Academic Data:
- Subject scores: ${JSON.stringify(data.marksBySubject)}
- Best subject: ${bestSubjectStr}
- Worst subject: ${weakSubjectStr}
- ALL subjects below 70% (need attention): ${allWeakSubjectsStr}
- Attendance: ${data.attendancePresent}/${data.attendanceTotal} days (${data.attendancePct}%)
- Study streak: ${data.currentStreak} days
- Weak topics: ${weakTopicsStr}
- Homework: ${data.homeworkSubmitted}/${data.homeworkAssigned} submitted (${data.homeworkNotSubmitted} not submitted${data.homeworkFlaggedCount > 0 ? `, ${data.homeworkFlaggedCount} flagged by AI` : ''})
- Tests: ${data.testsAttempted}/${data.testsScheduled} given (${data.testsMissed} missed)
- Suspicious activity in tests: ${suspiciousStr}

Generate a JSON report with this exact structure. No markdown, no extra text:
{
  "structured_lines": {
    "overall": "one sentence overall assessment (max 10 words)",
    "best_subject": "${data.bestSubject ?? 'null'}",
    "best_score": ${data.bestScore ?? 'null'},
    "weak_subject": "${data.weakSubject ?? 'null'}",
    "weak_score": ${data.weakScore ?? 'null'},
    "weak_subjects": ${JSON.stringify(data.weakSubjects)},
    "attendance_pct": ${data.attendancePct},
    "attendance_present": ${data.attendancePresent},
    "attendance_total": ${data.attendanceTotal},
    "streak_days": ${data.currentStreak},
    "homework_submitted": ${data.homeworkSubmitted},
    "homework_assigned": ${data.homeworkAssigned},
    "tests_missed": ${data.testsMissed},
    "suspicious_test_count": ${data.suspiciousTestCount},
    "tip": "one specific actionable tip for the parent (max 15 words)"
  },
  "summary_en": "3-4 sentences in English. Cover overall performance, mention ALL subjects below 70% by name with their scores, attendance, homework completion, and any other concerns. Warm but direct.",
  "summary_hi": "same in Hindi (Devanagari script)",
  "summary_gu": "same in Gujarati (Gujarati script)"
}

Rules:
- Be specific, not generic
- ALWAYS mention every subject below 70% by name in summary_en/hi/gu — do not omit any weak subject
- The overall field should reference the biggest concern (lowest scoring subject or most critical issue)
- Mention homework non-submission if homeworkNotSubmitted > 0
- Mention missed tests if testsMissed > 0
- Mention suspicious activity if suspiciousTestCount > 0 — use the word "integrity concern" not "cheating"
- If streak is 0, set streak_days to 0
- All scores are percentages (0-100)
- tip must address the biggest concern first`;

  const responseSchema = {
    type: 'object' as const,
    properties: {
      structured_lines: {
        type: 'object' as const,
        properties: {
          overall:              { type: 'string' as const },
          best_subject:         { type: 'string' as const },
          best_score:           { type: 'number' as const },
          weak_subject:         { type: 'string' as const },
          weak_score:           { type: 'number' as const },
          weak_subjects: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                subject: { type: 'string' as const },
                score:   { type: 'number' as const },
              },
            },
          },
          attendance_pct:       { type: 'number' as const },
          attendance_present:   { type: 'number' as const },
          attendance_total:     { type: 'number' as const },
          streak_days:          { type: 'number' as const },
          homework_submitted:   { type: 'number' as const },
          homework_assigned:    { type: 'number' as const },
          tests_missed:         { type: 'number' as const },
          suspicious_test_count:{ type: 'number' as const },
          tip:                  { type: 'string' as const },
        },
        required: [
          'overall', 'attendance_pct', 'attendance_present',
          'attendance_total', 'streak_days',
          'homework_submitted', 'homework_assigned',
          'tests_missed', 'suspicious_test_count', 'tip',
        ],
      },
      summary_en: { type: 'string' as const },
      summary_hi: { type: 'string' as const },
      summary_gu: { type: 'string' as const },
    },
    required: ['structured_lines', 'summary_en', 'summary_hi', 'summary_gu'],
  };

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    } as Record<string, unknown>,
  });

  const result = await model.generateContent(prompt);
  const raw    = result.response.text().trim();

  let parsed: MonthlyReportContent;
  try {
    parsed = JSON.parse(raw) as MonthlyReportContent;
  } catch {
    throw new Error(
      `[Monthly] Gemini returned invalid JSON for student ${data.studentId}: ${raw.slice(0, 200)}`
    );
  }

  // Normalise nullable fields — Gemini may return "null" string instead of null
  const sl = parsed.structured_lines;
  if ((sl.best_subject as unknown) === 'null' || sl.best_subject === '')
    sl.best_subject = null as unknown as string;
  if ((sl.weak_subject as unknown) === 'null' || sl.weak_subject === '')
    sl.weak_subject = null as unknown as string;
  if ((sl.best_score as unknown) === 'null') sl.best_score = null;
  if ((sl.weak_score as unknown) === 'null') sl.weak_score = null;
  // Ensure weak_subjects is always an array
  if (!Array.isArray(sl.weak_subjects)) sl.weak_subjects = null;

  return parsed;
}

// ── PART C — WhatsApp Message Assembly ───────────────────────────────────────

/**
 * Assembles a WhatsApp-ready formatted message from report content.
 */
export function assembleWhatsAppMessage(
  studentName: string,
  monthLabel: string,
  content: MonthlyReportContent
): string {
  const sl = content.structured_lines;

  const lines: string[] = [
    `📊 *${studentName} — Monthly Report | ${monthLabel}*`,
    '',
    `✅ Overall: ${sl.overall}`,
    `📚 Best Subject: ${sl.best_subject ?? 'N/A'} — ${sl.best_score ?? 'N/A'}%`,
  ];

  // ⚠️ List ALL weak subjects if available, fallback to single weak_subject
  const weakList = sl.weak_subjects && sl.weak_subjects.length > 0
    ? sl.weak_subjects
    : (sl.weak_subject ? [{ subject: sl.weak_subject, score: sl.weak_score ?? 0 }] : []);

  if (weakList.length === 1) {
    lines.push(`⚠️ Needs Attention: ${weakList[0].subject} — ${weakList[0].score}%`);
  } else if (weakList.length > 1) {
    lines.push(`⚠️ Needs Attention (${weakList.length} subjects):`);
    for (const w of weakList) {
      lines.push(`   • ${w.subject} — ${w.score}%`);
    }
  }

  lines.push(
    `📅 Attendance: ${sl.attendance_pct}% (${sl.attendance_present}/${sl.attendance_total} days)`
  );

  // 📝 Homework
  if (sl.homework_assigned > 0) {
    const notSubmitted = sl.homework_assigned - sl.homework_submitted;
    if (notSubmitted > 0) {
      lines.push(`📝 Homework: ${sl.homework_submitted}/${sl.homework_assigned} submitted (${notSubmitted} pending)`);
    } else {
      lines.push(`📝 Homework: All ${sl.homework_assigned} submitted ✓`);
    }
  }

  // 📋 Tests missed
  if (sl.tests_missed > 0) {
    lines.push(`📋 Tests Missed: ${sl.tests_missed}`);
  }

  // 🔥 streak only if > 0
  if (sl.streak_days > 0) {
    lines.push(`🔥 Study Streak: ${sl.streak_days} days`);
  }

  // 🚨 Integrity concern — only if suspicious activity found
  if (sl.suspicious_test_count > 0) {
    lines.push(`🚨 Integrity Concern: ${sl.suspicious_test_count} test(s) flagged for review`);
  }

  lines.push(
    '',
    '---',
    `🇬🇧 ${content.summary_en}`,
    `🇮🇳 ${content.summary_hi}`,
    `🇮🇳 ${content.summary_gu}`,
    '',
    '_Eduvo · Do not reply · Contact school for queries_'
  );

  return lines.join('\n');
}

// ── PART D — Save and Send ────────────────────────────────────────────────────

/**
 * Upserts the report into monthly_reports and optionally sends a WhatsApp message.
 */
export async function saveAndSendReport(
  studentId: string,
  monthStartDate: Date,
  reportText: string,
  whatsappMessage: string,
  parentPhone: string | null,
  sendWhatsApp: boolean
): Promise<void> {
  const now            = new Date().toISOString();
  const monthStartStr  = monthStartDate.toISOString().slice(0, 10);

  // 1. Upsert into monthly_reports
  const { error: upsertErr } = await supabaseAdmin
    .from('monthly_reports')
    .upsert(
      {
        student_id:       studentId,
        month_start_date: monthStartStr,
        report_text:      reportText,
        whatsapp_message: whatsappMessage,
        generated_at:     now,
      },
      {
        onConflict:      'student_id,month_start_date',
        ignoreDuplicates: false,
      }
    );

  if (upsertErr) {
    console.error(
      `[Monthly] monthly_reports upsert error for student ${studentId}:`,
      upsertErr.message
    );
    // Non-fatal — continue to WhatsApp attempt
  }

  // 2. Optionally send WhatsApp
  let whatsappSent = false;

  if (sendWhatsApp && parentPhone !== null) {
    const result = await sendWhatsAppMessage(parentPhone, whatsappMessage);

    if (result.sent) {
      whatsappSent = true;

      // Update whatsapp_sent_at
      const { error: updateErr } = await supabaseAdmin
        .from('monthly_reports')
        .update({ whatsapp_sent_at: new Date().toISOString() })
        .eq('student_id', studentId)
        .eq('month_start_date', monthStartStr);

      if (updateErr) {
        console.warn(
          `[Monthly] Failed to update whatsapp_sent_at for student ${studentId}:`,
          updateErr.message
        );
      }
    } else {
      console.warn(
        `[Monthly] WhatsApp not sent for student ${studentId}: ${result.reason ?? 'unknown reason'}`
      );
    }
  }

  const waStatus = sendWhatsApp
    ? (whatsappSent ? 'sent' : 'skipped (failed or no phone)')
    : 'skipped';

  console.log(
    `[Monthly] Report saved for student ${studentId}, WhatsApp: ${waStatus}`
  );
}

// ── PART E — Gemini Batch API ─────────────────────────────────────────────────

/**
 * Builds the Gemini prompt string for a given student (same prompt as Part B).
 * Extracted here so submitGeminiBatch can reuse it.
 */
function buildMonthlyPrompt(data: StudentMonthlyData, monthLabel: string): string {
  const weakTopicsStr =
    data.weakTopics.length > 0 ? data.weakTopics.join(', ') : 'none identified';

  const bestSubjectStr =
    data.bestSubject !== null
      ? `${data.bestSubject} (${data.bestScore}%)`
      : 'N/A';

  const weakSubjectStr =
    data.weakSubject !== null
      ? `${data.weakSubject} (${data.weakScore}%)`
      : 'null (all subjects above 70%)';

  const allWeakSubjectsStr =
    data.weakSubjects.length > 0
      ? data.weakSubjects.map((w) => `${w.subject} (${w.score}%)`).join(', ')
      : 'none (all subjects ≥ 70%)';

  const suspiciousStr =
    data.suspiciousTestCount > 0
      ? `${data.suspiciousTestCount} test(s) flagged (reasons: ${data.suspiciousReasons.join(', ') || 'unspecified'})`
      : 'none';

  return `You are generating a monthly academic report for an Indian school student.
Student: ${data.studentName}
Class: ${data.class}
Month: ${monthLabel}

Academic Data:
- Subject scores: ${JSON.stringify(data.marksBySubject)}
- Best subject: ${bestSubjectStr}
- Worst subject: ${weakSubjectStr}
- ALL subjects below 70% (need attention): ${allWeakSubjectsStr}
- Attendance: ${data.attendancePresent}/${data.attendanceTotal} days (${data.attendancePct}%)
- Study streak: ${data.currentStreak} days
- Weak topics: ${weakTopicsStr}
- Homework: ${data.homeworkSubmitted}/${data.homeworkAssigned} submitted (${data.homeworkNotSubmitted} not submitted${data.homeworkFlaggedCount > 0 ? `, ${data.homeworkFlaggedCount} flagged by AI` : ''})
- Tests: ${data.testsAttempted}/${data.testsScheduled} given (${data.testsMissed} missed)
- Suspicious activity in tests: ${suspiciousStr}

Generate a JSON report with this exact structure. No markdown, no extra text:
{
  "structured_lines": {
    "overall": "one sentence overall assessment (max 10 words)",
    "best_subject": "${data.bestSubject ?? 'null'}",
    "best_score": ${data.bestScore ?? 'null'},
    "weak_subject": "${data.weakSubject ?? 'null'}",
    "weak_score": ${data.weakScore ?? 'null'},
    "weak_subjects": ${JSON.stringify(data.weakSubjects)},
    "attendance_pct": ${data.attendancePct},
    "attendance_present": ${data.attendancePresent},
    "attendance_total": ${data.attendanceTotal},
    "streak_days": ${data.currentStreak},
    "homework_submitted": ${data.homeworkSubmitted},
    "homework_assigned": ${data.homeworkAssigned},
    "tests_missed": ${data.testsMissed},
    "suspicious_test_count": ${data.suspiciousTestCount},
    "tip": "one specific actionable tip for the parent (max 15 words)"
  },
  "summary_en": "3-4 sentences in English. Cover overall performance, mention ALL subjects below 70% by name with their scores, attendance, homework completion, and any other concerns. Warm but direct.",
  "summary_hi": "same in Hindi (Devanagari script)",
  "summary_gu": "same in Gujarati (Gujarati script)"
}

Rules:
- Be specific, not generic
- ALWAYS mention every subject below 70% by name in summary_en/hi/gu — do not omit any weak subject
- The overall field should reference the biggest concern (lowest scoring subject or most critical issue)
- Mention homework non-submission if homeworkNotSubmitted > 0
- Mention missed tests if testsMissed > 0
- Mention suspicious activity if suspiciousTestCount > 0 — use the word "integrity concern" not "cheating"
- If streak is 0, set streak_days to 0
- All scores are percentages (0-100)
- tip must address the biggest concern first`;
}

/**
 * Submits a Gemini Batch job for multiple students.
 * Returns the batch job ID, or null if batch is disabled or submission fails.
 */
export async function submitGeminiBatch(
  students: StudentMonthlyData[],
  monthLabel: string,
  monthStartDate: Date
): Promise<string | null> {
  if (process.env.GEMINI_BATCH_ENABLED !== 'true') {
    return null;
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
    if (!apiKey) {
      console.warn('[Monthly] Batch: Gemini API key not configured, skipping batch');
      return null;
    }

    const modelName  = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const genAI      = new GoogleGenerativeAI(apiKey);

    // Build one request per student
    const requests = students.map((data) => ({
      custom_id: data.studentId,
      method:    'POST',
      url:       `/v1beta/models/${modelName}:generateContent`,
      body: {
        contents: [
          {
            role:  'user',
            parts: [{ text: buildMonthlyPrompt(data, monthLabel) }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
        },
      },
    }));

    // Access the underlying SDK client to call the batch endpoint
    // The GoogleGenerativeAI SDK does not yet expose a first-class batch API,
    // so we call the REST endpoint directly using the SDK's API key.
    const axios = await import('axios');

    const response = await axios.default.post(
      `https://generativelanguage.googleapis.com/v1beta/batches`,
      {
        model:    `models/${modelName}`,
        requests,
      },
      {
        headers: {
          'x-goog-api-key':  apiKey,
          'Content-Type':    'application/json',
        },
        timeout: 30_000,
      }
    );

    const batchJobId: string | undefined =
      response.data?.name ?? response.data?.id ?? undefined;

    if (!batchJobId) {
      console.warn('[Monthly] Batch: submission succeeded but no job ID returned');
      return null;
    }

    console.log(
      `[Monthly] Batch submitted for ${students.length} students, job: ${batchJobId}`
    );

    // Store batch_job_id on the monthly_reports rows so we can poll later
    const monthStartStr = monthStartDate.toISOString().slice(0, 10);
    await supabaseAdmin
      .from('monthly_reports')
      .update({ batch_job_id: batchJobId })
      .in('student_id', students.map((s) => s.studentId))
      .eq('month_start_date', monthStartStr);

    return batchJobId;
  } catch (err) {
    console.error('[Monthly] Batch submission failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Polls Gemini Batch API status and returns results when complete.
 */
export async function checkGeminiBatch(batchJobId: string): Promise<{
  status: 'running' | 'completed' | 'failed';
  results?: Array<{
    studentId: string;
    content: MonthlyReportContent;
  }>;
}> {
  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '';
    if (!apiKey) {
      console.warn('[Monthly] checkGeminiBatch: Gemini API key not configured');
      return { status: 'failed' };
    }

    const axios = await import('axios');

    const response = await axios.default.get(
      `https://generativelanguage.googleapis.com/v1beta/${batchJobId}`,
      {
        headers: { 'x-goog-api-key': apiKey },
        timeout: 15_000,
      }
    );

    const jobData = response.data as Record<string, unknown>;
    const state   = (jobData.state as string | undefined)?.toLowerCase() ?? '';

    if (state === 'job_state_running' || state === 'processing' || state === 'submitted') {
      return { status: 'running' };
    }

    if (state === 'job_state_failed' || state === 'failed') {
      console.error(`[Monthly] Batch job ${batchJobId} failed:`, jobData.error ?? 'unknown');
      return { status: 'failed' };
    }

    if (state !== 'job_state_succeeded' && state !== 'completed') {
      // Unknown state — treat as still running
      console.warn(`[Monthly] Batch job ${batchJobId} unknown state: ${state}`);
      return { status: 'running' };
    }

    // Job completed — parse results
    const rawResults = (jobData.responses ?? jobData.results ?? []) as Array<
      Record<string, unknown>
    >;

    const results: Array<{ studentId: string; content: MonthlyReportContent }> = [];

    for (const item of rawResults) {
      const studentId = (item.custom_id ?? item.request_id ?? '') as string;
      if (!studentId) continue;

      try {
        // Extract text from Gemini response envelope
        const candidates = (item.response as Record<string, unknown>)
          ?.candidates as Array<Record<string, unknown>> | undefined;
        const text = (
          (candidates?.[0]?.content as Record<string, unknown>)
            ?.parts as Array<Record<string, unknown>>
        )?.[0]?.text as string | undefined;

        if (!text) {
          console.warn(`[Monthly] Batch: no text in response for student ${studentId}`);
          continue;
        }

        const parsed = JSON.parse(text) as MonthlyReportContent;

        // Normalise nullable fields
        const sl = parsed.structured_lines;
        if ((sl.best_subject as unknown) === 'null' || sl.best_subject === '')
          sl.best_subject = null as unknown as string;
        if ((sl.weak_subject as unknown) === 'null' || sl.weak_subject === '')
          sl.weak_subject = null as unknown as string;
        if ((sl.best_score as unknown) === 'null') sl.best_score = null;
        if ((sl.weak_score as unknown) === 'null') sl.weak_score = null;
        if (!Array.isArray(sl.weak_subjects)) sl.weak_subjects = null;

        results.push({ studentId, content: parsed });
      } catch (parseErr) {
        console.warn(
          `[Monthly] Batch: failed to parse result for student ${studentId}:`,
          parseErr instanceof Error ? parseErr.message : parseErr
        );
      }
    }

    console.log(
      `[Monthly] Batch ${batchJobId} completed. Parsed ${results.length}/${rawResults.length} results.`
    );

    return { status: 'completed', results };
  } catch (err) {
    console.error(
      `[Monthly] checkGeminiBatch error for job ${batchJobId}:`,
      err instanceof Error ? err.message : err
    );
    return { status: 'failed' };
  }
}
