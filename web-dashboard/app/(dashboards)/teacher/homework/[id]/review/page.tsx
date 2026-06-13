'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type FlaggedReason = 'low_confidence' | 'duplicate_image' | 'suspicious_perfect' | 'old_photo';
type AIResult = 'correct' | 'incorrect' | 'partial' | 'needs_review' | 'unclear' | null;
type TeacherResult = 'correct' | 'incorrect' | 'partial';

interface DuplicateSibling {
  student_name: string;
  roll_number: string | null;
  submission_text: string | null;
  submission_image_urls: string[] | null;
  submitted_at: string | null;
}

interface FlaggedSubmission {
  id: string;
  student_id: string;
  student_name: string;
  roll_number: string | null;
  submission_text: string | null;
  submission_image_urls: string[];
  submitted_at: string | null;
  ai_result: AIResult;
  ai_confidence: number | null;
  ai_feedback: string | null;
  teacher_reviewed: boolean;
  teacher_override_result: string | null;
  flagged_reason: FlaggedReason | null;
  duplicate_sibling: DuplicateSibling | null;
}

interface HomeworkReviewData {
  homework_id: string;
  title: string;
  subject_name: string | null;
  class_name: string;
  section: string;
  flagged_count: number;
  submissions: FlaggedSubmission[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FLAGGED_REASON_LABELS: Record<FlaggedReason, string> = {
  low_confidence: 'Low Confidence',
  duplicate_image: 'Duplicate Image',
  suspicious_perfect: 'Suspiciously Perfect',
  old_photo: 'Old Photo',
};

const FLAGGED_REASON_COLORS: Record<FlaggedReason, string> = {
  low_confidence: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  duplicate_image: 'bg-red-100 text-red-700 border-red-200',
  suspicious_perfect: 'bg-purple-100 text-purple-700 border-purple-200',
  old_photo: 'bg-orange-100 text-orange-700 border-orange-200',
};

const AI_RESULT_LABELS: Record<string, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  partial: 'Partial',
  needs_review: 'Needs Review',
  unclear: 'Unclear Image',
};

const AI_RESULT_COLORS: Record<string, string> = {
  correct: 'bg-green-100 text-green-700',
  incorrect: 'bg-red-100 text-red-700',
  partial: 'bg-yellow-100 text-yellow-700',
  needs_review: 'bg-orange-100 text-orange-700',
  unclear: 'bg-gray-100 text-gray-600',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function confidenceBar(conf: number | null) {
  if (conf === null) return null;
  const pct = Math.round(conf * 100);
  const color =
    pct >= 90 ? 'bg-green-500' :
    pct >= 70 ? 'bg-yellow-500' :
    'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 shrink-0">{pct}%</span>
    </div>
  );
}

// ── Image Lightbox ────────────────────────────────────────────────────────────

function ImageThumbnail({ url, alt }: { url: string; alt: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative group overflow-hidden rounded-lg border border-gray-200 bg-gray-50 hover:border-blue-400 transition-colors"
        aria-label={`View ${alt}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          className="w-24 h-24 object-cover group-hover:opacity-90 transition-opacity"
          loading="lazy"
        />
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
          <svg className="w-6 h-6 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
          </svg>
        </div>
      </button>

      {/* Lightbox */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <div className="relative max-w-4xl max-h-full" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={alt}
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-2 right-2 w-8 h-8 bg-black/60 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-colors"
              aria-label="Close image"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Submission Content ────────────────────────────────────────────────────────

function SubmissionContent({
  studentName,
  rollNumber,
  submissionText,
  imageUrls,
  submittedAt,
  isSecondary = false,
}: {
  studentName: string;
  rollNumber: string | null;
  submissionText: string | null;
  imageUrls: string[];
  submittedAt: string | null;
  isSecondary?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 space-y-3 ${isSecondary ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${isSecondary ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
          {studentName.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">
            {studentName}
            {rollNumber && <span className="text-gray-400 text-xs ml-1">#{rollNumber}</span>}
          </p>
          <p className="text-xs text-gray-400">{formatTime(submittedAt)}</p>
        </div>
        {isSecondary && (
          <span className="ml-auto text-xs font-medium px-2 py-0.5 bg-red-100 text-red-700 rounded-full border border-red-200">
            Original
          </span>
        )}
      </div>

      {submissionText && (
        <div className={`text-sm text-gray-800 leading-relaxed p-3 rounded-lg ${isSecondary ? 'bg-red-50' : 'bg-gray-50'}`}>
          {submissionText}
        </div>
      )}

      {imageUrls.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageUrls.map((url, i) => (
            <ImageThumbnail key={i} url={url} alt={`${studentName} submission image ${i + 1}`} />
          ))}
        </div>
      )}

      {!submissionText && imageUrls.length === 0 && (
        <p className="text-sm text-gray-400 italic">No submission content</p>
      )}
    </div>
  );
}

// ── Submission Card ───────────────────────────────────────────────────────────

function SubmissionCard({
  sub,
  onApprove,
  approving,
}: {
  sub: FlaggedSubmission;
  onApprove: (submissionId: string, result: TeacherResult, feedback: string) => Promise<void>;
  approving: string | null;
}) {
  const [feedback, setFeedback] = useState(sub.ai_feedback ?? '');
  const [showFeedback, setShowFeedback] = useState(false);
  const isDuplicate = sub.flagged_reason === 'duplicate_image';
  const isApproving = approving === sub.id;

  if (sub.teacher_reviewed) {
    return (
      <div className="bg-white rounded-2xl border border-green-200 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 bg-green-50">
          <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">{sub.student_name}</p>
            <p className="text-xs text-green-700">
              Reviewed — {sub.teacher_override_result ?? 'unknown'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-gray-100 bg-gray-50/60">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-base font-semibold text-gray-900">{sub.student_name}</p>
            {sub.roll_number && (
              <span className="text-xs text-gray-400">#{sub.roll_number}</span>
            )}
            <span className="text-xs text-gray-400">{formatTime(sub.submitted_at)}</span>
          </div>
        </div>

        {/* Flagged reason badge */}
        {sub.flagged_reason && (
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${FLAGGED_REASON_COLORS[sub.flagged_reason]}`}>
            ⚑ {FLAGGED_REASON_LABELS[sub.flagged_reason]}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Duplicate side-by-side */}
        {isDuplicate && sub.duplicate_sibling ? (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wide flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              Possible duplicate — compare side by side
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SubmissionContent
                studentName={sub.student_name}
                rollNumber={sub.roll_number}
                submissionText={sub.submission_text}
                imageUrls={sub.submission_image_urls}
                submittedAt={sub.submitted_at}
              />
              <SubmissionContent
                studentName={sub.duplicate_sibling.student_name}
                rollNumber={sub.duplicate_sibling.roll_number}
                submissionText={sub.duplicate_sibling.submission_text}
                imageUrls={sub.duplicate_sibling.submission_image_urls ?? []}
                submittedAt={sub.duplicate_sibling.submitted_at}
                isSecondary
              />
            </div>
          </div>
        ) : (
          <SubmissionContent
            studentName={sub.student_name}
            rollNumber={sub.roll_number}
            submissionText={sub.submission_text}
            imageUrls={sub.submission_image_urls}
            submittedAt={sub.submitted_at}
          />
        )}

        {/* AI result */}
        {(sub.ai_result || sub.ai_confidence !== null || sub.ai_feedback) && (
          <div className="rounded-xl border border-violet-100 bg-violet-50/50 p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-violet-700 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.416A2 2 0 0113 21H11a2 2 0 01-1.414-2.343l-.347-.416z" />
                </svg>
                AI Attempted
              </span>
              {sub.ai_result && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${AI_RESULT_COLORS[sub.ai_result]}`}>
                  {AI_RESULT_LABELS[sub.ai_result] ?? sub.ai_result}
                </span>
              )}
            </div>
            {sub.ai_confidence !== null && (
              <div>
                <p className="text-xs text-violet-600 mb-1">AI Confidence</p>
                {confidenceBar(sub.ai_confidence)}
              </div>
            )}
            {sub.ai_feedback && (
              <p className="text-xs text-gray-700 leading-relaxed">{sub.ai_feedback}</p>
            )}
          </div>
        )}

        {/* Feedback editor */}
        {showFeedback && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Feedback for student (optional)
            </label>
            <textarea
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Add feedback or correction note…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              maxLength={500}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onApprove(sub.id, 'correct', feedback)}
            disabled={!!approving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-green-300 rounded-lg transition-colors"
          >
            {isApproving ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            )}
            Approve as Correct
          </button>

          <button
            type="button"
            onClick={() => onApprove(sub.id, 'partial', feedback)}
            disabled={!!approving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-yellow-500 hover:bg-yellow-600 disabled:bg-yellow-200 rounded-lg transition-colors"
          >
            {isApproving ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            Mark as Partial
          </button>

          <button
            type="button"
            onClick={() => onApprove(sub.id, 'incorrect', feedback)}
            disabled={!!approving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-300 rounded-lg transition-colors"
          >
            {isApproving ? (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            Approve as Incorrect
          </button>

          <button
            type="button"
            onClick={() => setShowFeedback((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            {showFeedback ? 'Hide Feedback' : 'Edit Feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ReviewSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-200 p-5 animate-pulse space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-5 w-40 bg-gray-200 rounded" />
            <div className="h-5 w-24 bg-gray-200 rounded-full ml-auto" />
          </div>
          <div className="h-20 bg-gray-100 rounded-xl" />
          <div className="flex gap-2">
            <div className="h-9 w-32 bg-gray-200 rounded-lg" />
            <div className="h-9 w-28 bg-gray-200 rounded-lg" />
            <div className="h-9 w-36 bg-gray-200 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HomeworkReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const homeworkId = params.id;

  const [data, setData] = useState<HomeworkReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState('');

  const fetchFlagged = useCallback(async () => {
    const token = getToken();
    if (!token || !homeworkId) return;
    try {
      const res = await fetch(`${BASE_URL}/api/homework/${homeworkId}/flagged-submissions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load');
      setData(json.data as HomeworkReviewData);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load flagged submissions');
    } finally {
      setLoading(false);
    }
  }, [homeworkId]);

  useEffect(() => {
    fetchFlagged();
  }, [fetchFlagged]);

  const handleApprove = useCallback(async (
    submissionId: string,
    result: TeacherResult,
    feedback: string
  ) => {
    const token = getToken();
    if (!token) return;
    setApproving(submissionId);
    setApproveError('');

    try {
      const res = await fetch(`${BASE_URL}/api/homework/submissions/${submissionId}/review`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ result, feedback: feedback.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Review failed');

      // Optimistically mark as reviewed in local state
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          submissions: prev.submissions.map((s) =>
            s.id === submissionId
              ? { ...s, teacher_reviewed: true, teacher_override_result: result, status: 'checked' as const }
              : s
          ),
        };
      });
    } catch (err: unknown) {
      setApproveError(err instanceof Error ? err.message : 'Failed to save review');
    } finally {
      setApproving(null);
    }
  }, []);

  // ── Derived stats ──────────────────────────────────────────────────────────

  const reviewed = data?.submissions.filter((s) => s.teacher_reviewed).length ?? 0;
  const pending = (data?.flagged_count ?? 0) - reviewed;
  const allDone = data && pending === 0 && data.flagged_count > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <>
        <PageHeader title="Review Flagged Submissions" description="Loading…" />
        <ReviewSkeleton />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Review Flagged Submissions" description="" />
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data?.title ?? 'Review Flagged Submissions'}
        description={
          data
            ? `${data.class_name} · ${data.section}${data.subject_name ? ` · ${data.subject_name}` : ''}`
            : ''
        }
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push(`/teacher/homework/${homeworkId}/status`)}
              className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              ← All Submissions
            </button>
            <button
              onClick={() => router.push('/teacher/homework')}
              className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Homework
            </button>
          </div>
        }
      />

      {/* Progress summary */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-orange-700">{data.flagged_count}</p>
            <p className="text-xs text-orange-600 mt-0.5">Total Flagged</p>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-yellow-700">{pending}</p>
            <p className="text-xs text-yellow-600 mt-0.5">Pending Review</p>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-green-700">{reviewed}</p>
            <p className="text-xs text-green-600 mt-0.5">Reviewed</p>
          </div>
        </div>
      )}

      {approveError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {approveError}
        </div>
      )}

      {/* All done state */}
      {allDone && (
        <div className="mb-6 flex items-center gap-4 px-5 py-4 bg-green-50 border border-green-200 rounded-xl">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-green-800">All reviews complete!</p>
            <p className="text-xs text-green-600">All flagged submissions have been reviewed. Students have been notified.</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {data && data.flagged_count === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-base font-medium text-gray-700">No flagged submissions</p>
          <p className="text-sm text-gray-400 mt-1">All AI evaluations passed with high confidence. Nothing to review!</p>
          <button
            onClick={() => router.push(`/teacher/homework/${homeworkId}/status`)}
            className="mt-4 px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
          >
            View All Submissions
          </button>
        </div>
      )}

      {/* Submission cards */}
      {data && data.submissions.length > 0 && (
        <div className="space-y-5">
          {data.submissions.map((sub) => (
            <SubmissionCard
              key={sub.id}
              sub={sub}
              onApprove={handleApprove}
              approving={approving}
            />
          ))}
        </div>
      )}
    </>
  );
}
