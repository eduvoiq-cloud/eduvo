'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import {
  onboardingApi,
  usersApi,
  studentsApi,
  assignmentsApi,
  authApi,
  type OnboardingProgress,
  type Teacher,
  type TeacherAssignment,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssignForm {
  teacher_id: string;
  class_name: string;
  section: string;
  subject: string;
}

const EMPTY_ASSIGN: AssignForm = {
  teacher_id: '',
  class_name: '',
  section: '',
  subject: '',
};

// ── Step config ───────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'school_created', label: 'School Created ✓' },
  { key: 'teachers_imported', label: 'Import Your Teachers' },
  { key: 'students_imported', label: 'Import Your Students' },
  { key: 'teachers_assigned', label: 'Assign Teachers to Classes' },
  { key: 'done', label: "Start Using Eduvo!" },
] as const;

// ── Main component ────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Step 4 inline data
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [teacherCount, setTeacherCount] = useState(0);
  const [studentCount, setStudentCount] = useState(0);

  // Step 4 form
  const [assignForm, setAssignForm] = useState<AssignForm>(EMPTY_ASSIGN);
  const [assignError, setAssignError] = useState('');
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  // Mark-complete loading state
  const [markingComplete, setMarkingComplete] = useState(false);

  // ── Fetch onboarding status ───────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await onboardingApi.getStatus(token);
      const prog = res.data;

      // If already completed, redirect to dashboard
      if (prog.completed) {
        router.replace('/admin/dashboard');
        return;
      }

      setProgress(prog);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load onboarding status');
    } finally {
      setLoading(false);
    }
  }, [router]);

  // ── Fetch supporting data ─────────────────────────────────────────────────

  const fetchSupportingData = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    try {
      const [teachersRes, studentsRes, assignmentsRes] = await Promise.all([
        usersApi.list(token, { role: 'teacher', school_id: user.school_id }),
        studentsApi.list(token, user.school_id),
        assignmentsApi.list(token, user.school_id),
      ]);
      setTeachers(teachersRes.data ?? []);
      setTeacherCount((teachersRes.data ?? []).length);
      setStudentCount(((studentsRes.data as unknown as { length: number }) ?? []).length);
      setAssignments(assignmentsRes.data ?? []);
    } catch {
      // Non-fatal — counts just won't auto-update
    }
  }, [user]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (progress) {
      fetchSupportingData();
    }
  }, [progress, fetchSupportingData]);

  // ── Auto-mark steps based on counts ──────────────────────────────────────

  useEffect(() => {
    if (!progress) return;
    const token = getToken();
    if (!token) return;

    const updates: Promise<unknown>[] = [];

    if (teacherCount > 0 && !progress.teachers_imported) {
      updates.push(
        onboardingApi.updateStep(token, 'teachers_imported', true).then((res) =>
          setProgress(res.data)
        )
      );
    }

    if (studentCount > 0 && !progress.students_imported) {
      updates.push(
        onboardingApi.updateStep(token, 'students_imported', true).then((res) =>
          setProgress(res.data)
        )
      );
    }

    if (assignments.length > 0 && !progress.classes_created) {
      updates.push(
        onboardingApi.updateStep(token, 'classes_created', true).then((res) =>
          setProgress(res.data)
        )
      );
    }

    Promise.all(updates).catch(() => {});
  }, [teacherCount, studentCount, assignments.length, progress]);

  // ── Determine current active step index ──────────────────────────────────

  function getActiveStepIndex(): number {
    if (!progress) return 0;
    if (!progress.school_created) return 0;
    if (!progress.teachers_imported) return 1;
    if (!progress.students_imported) return 2;
    if (!progress.teachers_assigned) return 3;
    return 4;
  }

  // ── Add assignment (Step 4 inline form) ───────────────────────────────────

  async function handleAddAssignment(e: React.FormEvent) {
    e.preventDefault();
    setAssignError('');
    if (!assignForm.teacher_id || !assignForm.class_name.trim() || !assignForm.section.trim() || !assignForm.subject.trim()) {
      setAssignError('All fields are required.');
      return;
    }
    const token = getToken();
    if (!token || !user?.school_id) return;
    setAssignSubmitting(true);
    try {
      await assignmentsApi.create(token, {
        teacher_id: assignForm.teacher_id,
        school_id: user.school_id,
        class_name: assignForm.class_name.trim(),
        section: assignForm.section.trim(),
        subject: assignForm.subject.trim(),
      });
      setAssignForm(EMPTY_ASSIGN);
      await fetchSupportingData();
    } catch (e: unknown) {
      setAssignError(e instanceof Error ? e.message : 'Failed to add assignment');
    } finally {
      setAssignSubmitting(false);
    }
  }

  // ── Mark teachers_assigned complete ──────────────────────────────────────

  async function handleMarkAssignComplete() {
    if (assignments.length === 0) return;
    const token = getToken();
    if (!token) return;
    setMarkingComplete(true);
    try {
      const res = await onboardingApi.updateStep(token, 'teachers_assigned', true);
      setProgress(res.data);
    } catch (e: unknown) {
      setAssignError(e instanceof Error ? e.message : 'Failed to update step');
    } finally {
      setMarkingComplete(false);
    }
  }

  // ── Skip setup ────────────────────────────────────────────────────────────

  async function handleSkip() {
    const token = getToken();
    if (!token) return;
    try {
      // Mark all steps complete to skip
      await onboardingApi.updateStep(token, 'teachers_assigned', true);
      router.replace('/admin/dashboard');
    } catch {
      router.replace('/admin/dashboard');
    }
  }

  // ── Go to dashboard (Step 5) ──────────────────────────────────────────────

  async function handleGoToDashboard() {
    const token = getToken();
    if (!token) return;
    try {
      // Mark teachers_assigned true if not already, which triggers completed = true
      if (progress && !progress.teachers_assigned) {
        await onboardingApi.updateStep(token, 'teachers_assigned', true);
      }
    } catch {
      // Proceed anyway
    }
    router.replace('/admin/dashboard');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-sm text-red-600 mb-4">{error}</p>
          <button
            onClick={() => { setError(''); setLoading(true); fetchStatus(); }}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const activeStep = getActiveStepIndex();

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-2xl font-bold text-gray-900">Set Up Your School</h1>
          <p className="mt-2 text-sm text-gray-500">
            Complete these steps to get your school ready on Eduvo.
          </p>
        </div>

        {/* Stepper */}
        <div className="space-y-4">
          {STEPS.map((step, index) => {
            const isCompleted = getStepCompleted(step.key, progress, assignments);
            const isCurrent = index === activeStep && !isCompleted;
            const isFuture = index > activeStep && !isCompleted;

            return (
              <StepCard
                key={step.key}
                index={index}
                label={step.label}
                isCompleted={isCompleted}
                isCurrent={isCurrent}
                isFuture={isFuture}
              >
                {/* Step 1 — School Created */}
                {step.key === 'school_created' && (
                  <p className="text-sm text-green-700 font-medium">
                    Your school account is active and ready.
                  </p>
                )}

                {/* Step 2 — Import Teachers */}
                {step.key === 'teachers_imported' && (
                  <div>
                    {isCompleted ? (
                      <p className="text-sm text-green-700 font-medium">
                        {teacherCount} teacher{teacherCount !== 1 ? 's' : ''} added
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-gray-600 mb-3">
                          Add your teaching staff to get started.
                        </p>
                        <Link
                          href="/admin/import/teachers"
                          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                          Import Teachers
                          <ArrowRightIcon />
                        </Link>
                      </>
                    )}
                  </div>
                )}

                {/* Step 3 — Import Students */}
                {step.key === 'students_imported' && (
                  <div>
                    {isCompleted ? (
                      <p className="text-sm text-green-700 font-medium">
                        {studentCount} student{studentCount !== 1 ? 's' : ''} added
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-gray-600 mb-3">
                          Add all students using our Excel template. 1000 students in minutes.
                        </p>
                        <Link
                          href="/admin/import/students"
                          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                          Import Students
                          <ArrowRightIcon />
                        </Link>
                      </>
                    )}
                  </div>
                )}

                {/* Step 4 — Assign Teachers */}
                {step.key === 'teachers_assigned' && (
                  <div>
                    {isCompleted ? (
                      <p className="text-sm text-green-700 font-medium">
                        {assignments.length} assignment{assignments.length !== 1 ? 's' : ''} configured
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-gray-600 mb-4">
                          Tell us which teacher teaches which class and subject.
                        </p>

                        {/* Inline assignment form */}
                        <form onSubmit={handleAddAssignment} className="space-y-3 mb-4">
                          {assignError && (
                            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                              {assignError}
                            </div>
                          )}

                          {/* Teacher dropdown */}
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Teacher
                            </label>
                            <select
                              className={inputClass}
                              value={assignForm.teacher_id}
                              onChange={(e) =>
                                setAssignForm((f) => ({ ...f, teacher_id: e.target.value }))
                              }
                            >
                              <option value="">Select a teacher…</option>
                              {teachers.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                            {teachers.length === 0 && (
                              <p className="mt-1 text-xs text-amber-600">
                                No teachers yet.{' '}
                                <Link href="/admin/import/teachers" className="underline">
                                  Import teachers first.
                                </Link>
                              </p>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            {/* Class input */}
                            <div>
                              <label className="block text-xs font-medium text-gray-700 mb-1">
                                Class
                              </label>
                              <input
                                type="text"
                                className={inputClass}
                                placeholder="e.g. Grade 5"
                                value={assignForm.class_name}
                                onChange={(e) =>
                                  setAssignForm((f) => ({ ...f, class_name: e.target.value }))
                                }
                              />
                            </div>

                            {/* Section input */}
                            <div>
                              <label className="block text-xs font-medium text-gray-700 mb-1">
                                Section
                              </label>
                              <input
                                type="text"
                                className={inputClass}
                                placeholder="e.g. A"
                                value={assignForm.section}
                                onChange={(e) =>
                                  setAssignForm((f) => ({ ...f, section: e.target.value }))
                                }
                              />
                            </div>
                          </div>

                          {/* Subject dropdown */}
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Subject
                            </label>
                            <select
                              className={inputClass}
                              value={assignForm.subject}
                              onChange={(e) =>
                                setAssignForm((f) => ({ ...f, subject: e.target.value }))
                              }
                            >
                              <option value="">Select a subject…</option>
                              {SUBJECTS.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                              <option value="Other">Other</option>
                            </select>
                          </div>

                          <button
                            type="submit"
                            disabled={assignSubmitting}
                            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
                          >
                            {assignSubmitting ? 'Adding…' : 'Add Assignment'}
                          </button>
                        </form>

                        {/* Current assignments list */}
                        {assignments.length > 0 && (
                          <div className="mb-4">
                            <p className="text-xs font-medium text-gray-500 mb-2">
                              Current assignments
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {assignments.map((a) => {
                                const teacher = teachers.find((t) => t.id === a.teacher_id);
                                return (
                                  <span
                                    key={a.id}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-xs rounded-full"
                                  >
                                    <span className="font-medium">
                                      {teacher?.name ?? 'Teacher'}
                                    </span>
                                    <span className="text-gray-400">·</span>
                                    <span>
                                      {a.class_name} {a.section}
                                    </span>
                                    <span className="text-gray-400">·</span>
                                    <span>{a.subject}</span>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Mark complete button */}
                        {assignments.length > 0 && (
                          <button
                            onClick={handleMarkAssignComplete}
                            disabled={markingComplete}
                            className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-medium rounded-lg transition-colors"
                          >
                            {markingComplete ? 'Saving…' : 'Mark Step Complete'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Step 5 — You're Ready */}
                {step.key === 'done' && (
                  <div className="text-center py-2">
                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg
                        className="w-8 h-8 text-green-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-600 mb-6">
                      Your school is set up. Share the mobile app with parents and students to get
                      started.
                    </p>
                    <button
                      onClick={handleGoToDashboard}
                      className="w-full px-6 py-3 bg-green-600 hover:bg-green-700 text-white text-base font-semibold rounded-xl transition-colors shadow-sm"
                    >
                      Go to Dashboard
                    </button>
                  </div>
                )}
              </StepCard>
            );
          })}
        </div>

        {/* Skip link */}
        <div className="mt-8 text-center">
          <button
            onClick={handleSkip}
            className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors"
          >
            Skip Setup
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStepCompleted(
  key: string,
  progress: OnboardingProgress | null,
  assignments: TeacherAssignment[]
): boolean {
  if (!progress) return false;
  switch (key) {
    case 'school_created':
      return progress.school_created;
    case 'teachers_imported':
      return progress.teachers_imported;
    case 'students_imported':
      return progress.students_imported;
    case 'teachers_assigned':
      return progress.teachers_assigned;
    case 'done':
      // Step 5 is "active" when all prior steps are done
      return (
        progress.school_created &&
        progress.teachers_imported &&
        progress.students_imported &&
        progress.teachers_assigned
      );
    default:
      return false;
  }
}

const SUBJECTS = [
  'Mathematics',
  'English',
  'Science',
  'Social Studies',
  'History',
  'Geography',
  'Physics',
  'Chemistry',
  'Biology',
  'Computer Science',
  'Physical Education',
  'Art',
  'Music',
  'Religious Studies',
];

// ── StepCard component ────────────────────────────────────────────────────────

interface StepCardProps {
  index: number;
  label: string;
  isCompleted: boolean;
  isCurrent: boolean;
  isFuture: boolean;
  children: React.ReactNode;
}

function StepCard({
  index,
  label,
  isCompleted,
  isCurrent,
  isFuture,
  children,
}: StepCardProps) {
  const stepNumber = index + 1;

  return (
    <div
      className={`bg-white rounded-xl border transition-all ${
        isCurrent
          ? 'border-blue-300 shadow-sm ring-1 ring-blue-100'
          : isCompleted
          ? 'border-green-200'
          : 'border-gray-200 opacity-60'
      }`}
    >
      <div className="flex items-start gap-4 p-5">
        {/* Step indicator */}
        <div className="shrink-0 mt-0.5">
          {isCompleted ? (
            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center">
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          ) : isCurrent ? (
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
              <span className="text-white text-sm font-bold">{stepNumber}</span>
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
              <span className="text-gray-500 text-sm font-medium">{stepNumber}</span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3
            className={`text-sm font-semibold mb-1 ${
              isCompleted
                ? 'text-green-700'
                : isCurrent
                ? 'text-blue-700'
                : 'text-gray-500'
            }`}
          >
            {label}
          </h3>

          {/* Only show body for completed or current steps */}
          {(isCompleted || isCurrent) && (
            <div className="mt-2">{children}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ArrowRightIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
