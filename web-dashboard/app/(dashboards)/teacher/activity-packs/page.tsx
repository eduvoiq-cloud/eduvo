'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Activity {
  instruction: string;
  type: 'verbal' | 'written' | 'physical';
}

type Phase = 'setup' | 'preview' | 'success';
type CreationMode = 'ai' | 'manual';
type Board = 'GSEB' | 'CBSE' | 'ICSE' | 'Other';
type Language = 'English' | 'Gujarati' | 'Hindi' | 'Sanskrit' | 'Marathi' | 'Tamil' | 'Telugu' | 'Kannada' | 'Bengali' | 'Punjabi';

const BOARDS: { value: Board; label: string }[] = [
  { value: 'GSEB', label: 'GSEB (Gujarat Board)' },
  { value: 'CBSE', label: 'CBSE' },
  { value: 'ICSE', label: 'ICSE' },
  { value: 'Other', label: 'Other' },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'English',   label: 'English' },
  { value: 'Gujarati',  label: 'ગુજરાતી (Gujarati)' },
  { value: 'Hindi',     label: 'हिंदी (Hindi)' },
  { value: 'Sanskrit',  label: 'Sanskrit' },
  { value: 'Marathi',   label: 'मराठी (Marathi)' },
  { value: 'Tamil',     label: 'தமிழ் (Tamil)' },
  { value: 'Telugu',    label: 'తెలుగు (Telugu)' },
  { value: 'Kannada',   label: 'ಕನ್ನಡ (Kannada)' },
  { value: 'Bengali',   label: 'বাংলা (Bengali)' },
  { value: 'Punjabi',   label: 'ਪੰਜਾਬੀ (Punjabi)' },
];

const TYPE_BADGE: Record<Activity['type'], { label: string; cls: string; icon: string }> = {
  verbal:   { label: 'Verbal',   cls: 'bg-blue-100 text-blue-700',    icon: '💬' },
  written:  { label: 'Written',  cls: 'bg-purple-100 text-purple-700', icon: '✏️' },
  physical: { label: 'Physical', cls: 'bg-green-100 text-green-700',   icon: '🤸' },
};

const ACCEPTED_FILE_TYPES = 'image/jpeg,image/png,image/webp,image/gif,application/pdf';
const MAX_FILE_MB = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function emptyActivity(): Activity {
  return { instruction: '', type: 'verbal' };
}

// ── File upload widget ─────────────────────────────────────────────────────────

function FileUpload({ onFile, onClear, fileName }: {
  onFile: (file: File) => void; onClear: () => void; fileName: string | null;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`File must be under ${MAX_FILE_MB} MB`);
      return;
    }
    onFile(file);
  }

  return (
    <div>
      {fileName ? (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
          <svg className="w-5 h-5 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          <span className="text-sm text-blue-800 font-medium flex-1 truncate">{fileName}</span>
          <button type="button" onClick={onClear} className="text-xs text-red-500 hover:text-red-700 font-medium shrink-0">Remove</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          className="w-full flex items-center gap-3 px-4 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/40 transition-colors"
        >
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Upload image or PDF to generate activities from (optional, max {MAX_FILE_MB} MB)</span>
        </button>
      )}
      <input ref={ref} type="file" accept={ACCEPTED_FILE_TYPES} className="hidden" onChange={handleChange} />
    </div>
  );
}

// ── Manual activity editor ─────────────────────────────────────────────────────

function ManualActivityEditor({
  activity,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  activity: Activity;
  index: number;
  onChange: (updated: Activity) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">Activity {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} className="text-xs text-red-500 hover:underline">
            Remove
          </button>
        )}
      </div>

      <FormField label="Instruction" htmlFor={`ma-inst-${index}`} required>
        <textarea
          id={`ma-inst-${index}`}
          rows={2}
          className={`${inputClass} resize-none`}
          placeholder="Describe the activity for the parent and child..."
          value={activity.instruction}
          onChange={(e) => onChange({ ...activity, instruction: e.target.value })}
        />
      </FormField>

      <FormField label="Type" htmlFor={`ma-type-${index}`}>
        <select
          id={`ma-type-${index}`}
          className={inputClass}
          value={activity.type}
          onChange={(e) => onChange({ ...activity, type: e.target.value as Activity['type'] })}
        >
          <option value="verbal">💬 Verbal</option>
          <option value="written">✏️ Written</option>
          <option value="physical">🤸 Physical</option>
        </select>
      </FormField>
    </div>
  );
}

// ── Activity card (preview mode) ───────────────────────────────────────────────

function ActivityCard({
  activity,
  index,
  onEdit,
  onRemove,
}: {
  activity: Activity;
  index: number;
  onEdit: (updated: Activity) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Activity>({ ...activity });
  const badge = TYPE_BADGE[activity.type];

  function save() {
    onEdit(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">Activity {index + 1} — Editing</span>
          <button
            onClick={() => { setDraft({ ...activity }); setEditing(false); }}
            className="text-xs text-gray-500 hover:text-red-500"
          >
            Cancel
          </button>
        </div>

        <FormField label="Instruction" htmlFor={`a-inst-${index}`} required>
          <textarea
            id={`a-inst-${index}`}
            rows={3}
            className={`${inputClass} resize-none`}
            value={draft.instruction}
            onChange={(e) => setDraft((d) => ({ ...d, instruction: e.target.value }))}
          />
        </FormField>

        <FormField label="Type" htmlFor={`a-type-${index}`}>
          <select
            id={`a-type-${index}`}
            className={inputClass}
            value={draft.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as Activity['type'] }))}
          >
            <option value="verbal">💬 Verbal</option>
            <option value="written">✏️ Written</option>
            <option value="physical">🤸 Physical</option>
          </select>
        </FormField>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => { setDraft({ ...activity }); setEditing(false); }}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-400">#{index + 1}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge.cls}`}>
            {badge.icon} {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setDraft({ ...activity }); setEditing(true); }}
            className="text-xs text-blue-600 hover:underline"
          >
            Edit
          </button>
          <button onClick={onRemove} className="text-xs text-red-500 hover:underline">
            Remove
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-800 leading-relaxed">{activity.instruction}</p>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ActivityPacksPage() {
  const { user } = useAuth();
  const router = useRouter();

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Pack setup fields
  const [className, setClassName] = useState('');
  const [section, setSection] = useState('');
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [board, setBoard] = useState<Board>('GSEB');
  const [chapter, setChapter] = useState('');
  const [language, setLanguage] = useState<Language>('English');

  // AI options
  const [activityCount, setActivityCount] = useState(5);

  // File upload
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  // Creation mode
  const [creationMode, setCreationMode] = useState<CreationMode>('ai');

  // AI generation state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // Manual activities state
  const [manualActivities, setManualActivities] = useState<Activity[]>([emptyActivity()]);
  const [manualError, setManualError] = useState('');

  // Preview state
  const [activities, setActivities] = useState<Activity[]>([]);
  const [phase, setPhase] = useState<Phase>('setup');

  // Send state
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  // ── Check permission ───────────────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user) return;
    if (user.role !== 'teacher') { setHasPermission(false); return; }

    fetch(`${BASE_URL}/api/activity-packs/permission`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((j) => setHasPermission(j.data?.can_create_activity_packs === true))
      .catch(() => setHasPermission(false));
  }, [user]);

  // ── Fetch assignments ──────────────────────────────────────────────────────

  const fetchAssignments = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    try {
      const res = await assignmentsApi.list(token, user.school_id);
      setAssignments(res.data.filter((a) => a.teacher_id === user.id));
    } catch { /* silent */ }
    finally { setLoadingAssignments(false); }
  }, [user]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // ── Derived dropdowns ──────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();

  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === className).map((a) => a.section)
  )].sort();

  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === className && a.section === section)
      .map((a) => a.subject)
  )].sort();

  // ── Validate setup fields ──────────────────────────────────────────────────

  function validateSetup(): string | null {
    if (!className) return 'Please select a class.';
    if (!section) return 'Please select a section.';
    if (!subject) return 'Please select a subject.';
    if (!topic.trim()) return 'Please enter the topic.';
    return null;
  }

  // ── Generate activities (AI) ───────────────────────────────────────────────

  async function handleGenerate() {
    const err = validateSetup();
    if (err) { setGenerateError(err); return; }
    setGenerateError('');
    setGenerating(true);
    try {
      const token = getToken();

      // Prepare file data if uploaded
      let file_data: string | undefined;
      let file_mime: string | undefined;
      if (uploadedFile) {
        file_data = await fileToBase64(uploadedFile);
        file_mime = uploadedFile.type;
      }

      const res = await fetch(`${BASE_URL}/api/activity-packs/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          class: className,
          subject,
          topic: topic.trim(),
          board,
          chapter: chapter.trim(),
          count: activityCount,
          language,
          ...(file_data ? { file_data, file_mime } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Generation failed');
      setActivities(json.data.activities as Activity[]);
      setPhase('preview');
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'AI generation failed. Try again or create manually.');
    } finally {
      setGenerating(false);
    }
  }

  // ── Submit manual activities ───────────────────────────────────────────────

  function handleManualSubmit() {
    const err = validateSetup();
    if (err) { setManualError(err); return; }

    for (let i = 0; i < manualActivities.length; i++) {
      if (!manualActivities[i].instruction.trim()) {
        setManualError(`Activity ${i + 1}: instruction is required.`);
        return;
      }
    }

    setManualError('');
    setActivities(manualActivities);
    setPhase('preview');
  }

  // ── Send to parents ────────────────────────────────────────────────────────

  async function handleSend() {
    setSendError('');
    setSending(true);
    try {
      const token = getToken();
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${BASE_URL}/api/activity-packs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          class: className,
          section,
          subject,
          topic: topic.trim(),
          activity_date: today,
          activities,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to send activity pack');
      setPhase('success');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Failed to send. Please try again.');
    } finally {
      setSending(false);
    }
  }

  // ── Loading / permission gate ──────────────────────────────────────────────

  if (hasPermission === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (hasPermission === false) {
    return (
      <>
        <PageHeader
          title="Activity Packs"
          description="Send AI-generated home activities to parents"
        />
        <div className="max-w-lg mx-auto mt-8 text-center py-16 px-6 bg-white rounded-xl border border-gray-200">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Access Required</h2>
          <p className="text-sm text-gray-500">
            Your school admin needs to grant you Activity Pack access. Contact your administrator.
          </p>
        </div>
      </>
    );
  }

  // ── Success screen ─────────────────────────────────────────────────────────

  if (phase === 'success') {
    return (
      <>
        <PageHeader title="Activity Packs" description="Pack sent successfully" />
        <div className="max-w-lg mx-auto mt-8 text-center py-16 px-6 bg-white rounded-xl border border-gray-200">
          <div className="text-5xl mb-4">🎉</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Activity Pack Sent!</h2>
          <p className="text-sm text-gray-600 mb-6">
            Today&apos;s <strong>{subject}</strong> activity pack on &quot;<strong>{topic}</strong>&quot; has been
            sent to parents of Class {className} {section}. They&apos;ve been notified via the app.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => {
                setPhase('setup');
                setActivities([]);
                setTopic('');
                setChapter('');
                setManualActivities([emptyActivity()]);
                setCreationMode('ai');
                setActivityCount(5);
                setLanguage('English');
                setUploadedFile(null);
              }}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
            >
              Create Another Pack
            </button>
            <button
              onClick={() => router.push('/teacher/dashboard')}
              className="px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </>
    );
  }

  // ── Preview screen ─────────────────────────────────────────────────────────

  if (phase === 'preview') {
    const typeCounts = activities.reduce<Record<string, number>>((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {});

    return (
      <>
        <PageHeader
          title="Activity Packs"
          description={`Preview: ${subject} - ${topic}`}
          action={
            <button
              onClick={() => setPhase('setup')}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
          }
        />

        {/* Summary bar */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-xl mb-5 text-sm">
          <span className="font-semibold text-gray-900">{activities.length} activities</span>
          <span className="text-gray-300">·</span>
          {typeCounts.verbal   && <span className="text-blue-600 font-medium">💬 {typeCounts.verbal} verbal</span>}
          {typeCounts.written  && <span className="text-purple-600 font-medium">✏️ {typeCounts.written} written</span>}
          {typeCounts.physical && <span className="text-green-600 font-medium">🤸 {typeCounts.physical} physical</span>}
          <span className="text-gray-300">·</span>
          <span className="text-gray-500">Class {className} {section}</span>
          <span className="text-gray-300">·</span>
          <span className="text-gray-500">{board}</span>
          {chapter && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-gray-500">{chapter}</span>
            </>
          )}
        </div>

        {/* Note */}
        <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 text-xs text-amber-700 mb-5">
          <strong>About these activities:</strong> Designed for 3-5 minutes each, done WITH a parent at home.
          They reinforce today&apos;s lesson in a fun, non-testing way aligned with {board} curriculum.
        </div>

        {/* Activities list */}
        <div className="space-y-3 mb-6">
          {activities.map((a, idx) => (
            <ActivityCard
              key={idx}
              activity={a}
              index={idx}
              onEdit={(updated) =>
                setActivities((prev) => prev.map((x, i) => i === idx ? updated : x))
              }
              onRemove={() =>
                setActivities((prev) => prev.filter((_, i) => i !== idx))
              }
            />
          ))}
        </div>

        {activities.length === 0 && (
          <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl mb-6">
            <p className="text-sm text-gray-400">All activities removed. Go back and regenerate.</p>
          </div>
        )}

        {sendError && (
          <div className="mb-4 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {sendError}
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={() => setPhase('setup')}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            &larr; Back
          </button>
          <button
            onClick={handleSend}
            disabled={sending || activities.length === 0}
            className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-sm font-semibold rounded-lg"
          >
            {sending ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
                Send to Parents
              </>
            )}
          </button>
        </div>
      </>
    );
  }

  // ── Setup screen ───────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Activity Packs"
        description="Send home activities to parents of junior students"
      />

      <div className="max-w-2xl space-y-6">

        {/* ── Pack Setup ──────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-900">Pack Setup</h2>

          {/* Class + Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Class" htmlFor="ap-class" required>
              <select
                id="ap-class"
                className={inputClass}
                disabled={loadingAssignments}
                value={className}
                onChange={(e) => { setClassName(e.target.value); setSection(''); setSubject(''); }}
              >
                <option value="">{loadingAssignments ? 'Loading...' : 'Select class...'}</option>
                {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>

            <FormField label="Section" htmlFor="ap-section" required>
              <select
                id="ap-section"
                className={inputClass}
                disabled={!className}
                value={section}
                onChange={(e) => { setSection(e.target.value); setSubject(''); }}
              >
                <option value="">Select section...</option>
                {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>
          </div>

          {/* Subject + Board */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Subject" htmlFor="ap-subject" required>
              <select
                id="ap-subject"
                className={inputClass}
                disabled={!section}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">Select subject...</option>
                {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>

            <FormField label="Board / Curriculum" htmlFor="ap-board" required>
              <select
                id="ap-board"
                className={inputClass}
                value={board}
                onChange={(e) => setBoard(e.target.value as Board)}
              >
                {BOARDS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Language */}
          <FormField label="Activity Language" htmlFor="ap-language" required>
            <select
              id="ap-language"
              className={inputClass}
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </FormField>

          {/* Topic */}
          <FormField label="What topic did you teach today?" htmlFor="ap-topic" required>
            <input
              id="ap-topic"
              type="text"
              className={inputClass}
              placeholder="e.g. Addition of two-digit numbers, Plants around us..."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && creationMode === 'ai') handleGenerate(); }}
            />
          </FormField>

          {/* Chapter / Unit (optional) */}
          <FormField label="Chapter / Unit" htmlFor="ap-chapter">
            <input
              id="ap-chapter"
              type="text"
              className={inputClass}
              placeholder="e.g. Chapter 3: Fractions, Unit 2: Photosynthesis (optional)"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
            />
          </FormField>

          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700">
            <strong>Note:</strong> Activities will be sent to parents of students in Class{' '}
            {className || '—'} {section || '—'} with an active <strong>Premium Junior</strong> subscription.
            Parents will receive a push notification.
          </div>
        </div>

        {/* ── Mode toggle ─────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setCreationMode('ai'); setGenerateError(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
              creationMode === 'ai'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            ✨ Generate with AI
          </button>
          <button
            onClick={() => { setCreationMode('manual'); setGenerateError(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
              creationMode === 'manual'
                ? 'bg-gray-800 text-white border-gray-800'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
          >
            ✏️ Create Manually
          </button>
        </div>

        {/* ── AI mode ─────────────────────────────────────────────────────── */}
        {creationMode === 'ai' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">

            {/* Number of activities */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">
                Number of Activities to Generate
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                {[3, 4, 5, 6, 7, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setActivityCount(n)}
                    className={`w-10 h-10 rounded-lg text-sm font-semibold border transition-colors ${
                      activityCount === n
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400">
                AI will generate exactly {activityCount} activities, each ~3-5 minutes, designed for a parent and child together.
              </p>
            </div>

            {/* File upload */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Generate from Image / PDF</label>
              <FileUpload
                onFile={(f) => setUploadedFile(f)}
                onClear={() => setUploadedFile(null)}
                fileName={uploadedFile?.name ?? null}
              />
              {uploadedFile && (
                <p className="text-xs text-blue-600">📎 AI will use the uploaded file as the source for activities.</p>
              )}
            </div>

            {generateError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 space-y-2">
                <p>{generateError}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-red-300"
                  >
                    {generating ? 'Retrying...' : 'Retry'}
                  </button>
                  <button
                    onClick={() => { setCreationMode('manual'); setGenerateError(''); }}
                    className="px-3 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
                  >
                    Create Manually Instead
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleGenerate}
                disabled={generating || !className || !section || !subject || !topic.trim()}
                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {generating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Generate {activityCount} Activities
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Manual mode ─────────────────────────────────────────────────── */}
        {creationMode === 'manual' && (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 text-xs text-amber-700">
              Add at least 1 activity. Each activity needs an instruction and a type (verbal, written, or physical).
            </div>

            {manualError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {manualError}
              </div>
            )}

            {manualActivities.map((a, idx) => (
              <ManualActivityEditor
                key={idx}
                activity={a}
                index={idx}
                onChange={(updated) =>
                  setManualActivities((prev) => prev.map((x, i) => i === idx ? updated : x))
                }
                onRemove={() =>
                  setManualActivities((prev) => prev.filter((_, i) => i !== idx))
                }
                canRemove={manualActivities.length > 1}
              />
            ))}

            <div className="flex items-center justify-between">
              <button
                onClick={() => setManualActivities((prev) => [...prev, emptyActivity()])}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Another Activity
              </button>

              <button
                onClick={handleManualSubmit}
                disabled={!className || !section || !subject || !topic.trim()}
                className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-sm font-semibold rounded-lg"
              >
                Preview &amp; Send &rarr;
              </button>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
