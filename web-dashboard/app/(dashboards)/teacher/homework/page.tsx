'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Subject {
  id: string;
  name: string;
}

interface HomeworkItem {
  id: string;
  title: string;
  description: string | null;
  subject_name: string | null;
  subject_id?: string;
  teacher_name: string | null;
  due_date: string;
  file_url: string | null;
  created_at: string;
  ai_check_enabled?: boolean;
}

interface AckCount {
  acknowledged_count: number;
  total_students: number;
}

interface AISettings {
  reference_answer: string;
  submission_type: 'typed' | 'photo' | 'either';
  subject_type: 'theory' | 'numerical' | 'mixed' | '';
  min_word_count: string;
  requires_diagram: boolean;
}

interface HomeworkForm {
  subject_id: string;
  custom_subject: string;
  class_name: string;
  section: string;
  title: string;
  description: string;
  due_date: string;
  file: File | null;
  // AI checking
  ai_check_enabled: boolean;
  ai_settings: AISettings;
  // Template
  save_as_template: boolean;
  template_name: string;
}

interface HWTemplate {
  id: string;
  template_name: string;
  subject: string;
  reference_answer: string | null;
  submission_type: 'typed' | 'photo' | 'either';
  subject_type: 'theory' | 'numerical' | 'mixed' | null;
  min_word_count: number | null;
  requires_diagram: boolean;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUBJECT_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-green-100 text-green-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
  'bg-yellow-100 text-yellow-700',
  'bg-red-100 text-red-700',
];

// Auto-suggest subject_type based on subject name keywords
function suggestSubjectType(subjectName: string): 'theory' | 'numerical' | 'mixed' | '' {
  const name = subjectName.toLowerCase();
  if (/math|maths|mathematics|physics|chemistry|accounts|accountancy|economics/.test(name)) return 'numerical';
  if (/history|civics|geography|biology|english|hindi|gujarati|social|science|evs/.test(name)) return 'theory';
  return 'mixed';
}

function subjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
}

function formatDueDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_AI_SETTINGS: AISettings = {
  reference_answer: '',
  submission_type: 'either',
  subject_type: '',
  min_word_count: '',
  requires_diagram: false,
};

const DEFAULT_FORM: HomeworkForm = {
  subject_id: '',
  custom_subject: '',
  class_name: '',
  section: '',
  title: '',
  description: '',
  due_date: '',
  file: null,
  ai_check_enabled: false,
  ai_settings: { ...DEFAULT_AI_SETTINGS },
  save_as_template: false,
  template_name: '',
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function HomeworkSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
          <div className="flex items-start gap-3">
            <div className="h-6 w-20 bg-gray-200 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-5 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-200 rounded w-full" />
              <div className="h-3 bg-gray-200 rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
        checked ? 'bg-blue-600' : 'bg-gray-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ── Homework Card ─────────────────────────────────────────────────────────────

function HomeworkCard({
  item,
  ackCount,
  onEdit,
  onDelete,
  onViewStatus,
}: {
  item: HomeworkItem;
  ackCount: AckCount | null;
  onEdit: (item: HomeworkItem) => void;
  onDelete: (item: HomeworkItem) => void;
  onViewStatus: (item: HomeworkItem) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const colorClass = subjectColor(item.subject_name ?? 'General');

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Subject badge */}
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0 ${colorClass}`}>
            {item.subject_name ?? 'General'}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-gray-900 leading-snug">{item.title}</h3>
              {item.ai_check_enabled && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.416A2 2 0 0113 21H11a2 2 0 01-1.414-2.343l-.347-.416z" />
                  </svg>
                  AI Checking
                </span>
              )}
            </div>
            {item.description && (
              <p className="mt-1 text-sm text-gray-500 line-clamp-2">{item.description}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Due: {formatDueDate(item.due_date)}
              </span>
              {ackCount !== null && (
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {ackCount.acknowledged_count} / {ackCount.total_students} acknowledged
                </span>
              )}
              {item.file_url && (
                <a href={item.file_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-blue-600 hover:underline">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  Attachment
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons — visible on hover */}
        <div className={`flex items-center gap-2 flex-shrink-0 transition-opacity ${hovered ? 'opacity-100' : 'opacity-0'}`}>
          {item.ai_check_enabled && (
            <button onClick={() => onViewStatus(item)}
              className="px-3 py-1.5 text-xs font-medium text-violet-700 border border-violet-200 rounded-lg hover:bg-violet-50 transition-colors">
              Status
            </button>
          )}
          <button onClick={() => onEdit(item)}
            className="px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
            Edit
          </button>
          <button onClick={() => onDelete(item)}
            className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AI Check Settings Panel ───────────────────────────────────────────────────

function AICheckSettings({
  settings,
  onChange,
  subjectName,
  subjectId,
  className,
  section,
  token,
  // template props
  templates,
  loadingTemplates,
  onLoadTemplate,
  saveAsTemplate,
  onSaveAsTemplateChange,
  templateName,
  onTemplateNameChange,
}: {
  settings: AISettings;
  onChange: (s: AISettings) => void;
  subjectName: string;
  subjectId: string;
  className: string;
  section: string;
  token: string | null;
  templates: HWTemplate[];
  loadingTemplates: boolean;
  onLoadTemplate: (t: HWTemplate) => void;
  saveAsTemplate: boolean;
  onSaveAsTemplateChange: (v: boolean) => void;
  templateName: string;
  onTemplateNameChange: (v: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadingYesterday, setLoadingYesterday] = useState(false);
  const [yesterdayError, setYesterdayError] = useState('');

  const set = (patch: Partial<AISettings>) => onChange({ ...settings, ...patch });

  async function handleSameAsYesterday() {
    if (!token || !subjectId || !className || !section) return;
    setLoadingYesterday(true);
    setYesterdayError('');
    try {
      const qs = new URLSearchParams({ subject_id: subjectId, class: className, section });
      const res = await fetch(`${BASE_URL}/api/homework/last-ai-settings?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to fetch');
      if (!json.data) {
        setYesterdayError('No previous AI-checked homework found for this subject + class.');
        return;
      }
      const d = json.data;
      onChange({
        reference_answer: d.reference_answer ?? '',
        submission_type: d.submission_type ?? 'either',
        subject_type: d.subject_type ?? '',
        min_word_count: d.min_word_count ? String(d.min_word_count) : '',
        requires_diagram: d.requires_diagram ?? false,
      });
      setExpanded(true);
    } catch (err: unknown) {
      setYesterdayError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoadingYesterday(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Quick action buttons */}
      <div className="flex flex-wrap gap-2">
        {/* Use Template dropdown */}
        <div className="relative group/tmpl">
          <button type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            disabled={loadingTemplates}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Use Template
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {templates.length > 0 && (
            <div className="absolute left-0 top-full mt-1 z-10 min-w-[200px] max-w-xs bg-white border border-gray-200 rounded-xl shadow-lg py-1 hidden group-hover/tmpl:block">
              {templates.map((t) => (
                <button key={t.id} type="button"
                  onClick={() => { onLoadTemplate(t); setExpanded(true); }}
                  className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 transition-colors truncate">
                  <span className="font-medium">{t.template_name}</span>
                  <span className="text-gray-400 ml-1">· {t.subject}</span>
                </button>
              ))}
            </div>
          )}
          {templates.length === 0 && !loadingTemplates && (
            <div className="absolute left-0 top-full mt-1 z-10 bg-white border border-gray-200 rounded-xl shadow-lg py-2 px-3 hidden group-hover/tmpl:block">
              <p className="text-xs text-gray-400 whitespace-nowrap">No templates saved yet</p>
            </div>
          )}
        </div>

        {/* Same as Yesterday */}
        <button type="button"
          onClick={handleSameAsYesterday}
          disabled={loadingYesterday || !subjectId || !className || !section}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {loadingYesterday ? (
            <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          Same as Yesterday
        </button>
      </div>

      {yesterdayError && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{yesterdayError}</p>
      )}

      {/* Collapsible AI settings */}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <button type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-sm font-medium text-gray-700">
          <span className="flex items-center gap-2">
            <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            AI Check Settings
            <span className="text-xs font-normal text-gray-400">(optional)</span>
          </span>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {expanded && (
          <div className="p-4 space-y-4 bg-white">
            {/* Reference answer */}
            <FormField label="Reference Answer / Method Taught" htmlFor="ai-ref">
              <textarea id="ai-ref" className={`${inputClass} resize-none`} rows={3} maxLength={5000}
                placeholder="Paste the correct answer or method you taught in class (helps AI grade more accurately)…"
                value={settings.reference_answer}
                onChange={(e) => set({ reference_answer: e.target.value })} />
              <p className="mt-1 text-xs text-gray-400 text-right">{settings.reference_answer.length}/5000</p>
            </FormField>

            {/* Submission type */}
            <FormField label="Submission Type" htmlFor="ai-subtype">
              <div className="flex gap-4">
                {(['either', 'typed', 'photo'] as const).map((v) => (
                  <label key={v} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                    <input type="radio" name="submission_type" value={v}
                      checked={settings.submission_type === v}
                      onChange={() => set({ submission_type: v })}
                      className="accent-blue-600" />
                    {v === 'either' ? 'Either' : v === 'typed' ? 'Typed answer' : 'Photo upload'}
                  </label>
                ))}
              </div>
            </FormField>

            {/* Subject type */}
            <FormField label="Subject Type" htmlFor="ai-subjtype">
              <select id="ai-subjtype" className={inputClass}
                value={settings.subject_type}
                onChange={(e) => set({ subject_type: e.target.value as AISettings['subject_type'] })}>
                <option value="">Select…</option>
                <option value="theory">Theory</option>
                <option value="numerical">Numerical</option>
                <option value="mixed">Mixed</option>
              </select>
              {subjectName && settings.subject_type === '' && (
                <p className="mt-1 text-xs text-gray-400">
                  Suggested for <span className="font-medium">{subjectName}</span>:{' '}
                  <button type="button" className="text-blue-600 underline"
                    onClick={() => set({ subject_type: suggestSubjectType(subjectName) })}>
                    {suggestSubjectType(subjectName)}
                  </button>
                </p>
              )}
            </FormField>

            {/* Min word count (theory only) */}
            {settings.subject_type === 'theory' && (
              <FormField label="Minimum Word Count" htmlFor="ai-words">
                <input id="ai-words" type="number" className={inputClass} min={1} max={5000}
                  placeholder="e.g. 50 (optional)"
                  value={settings.min_word_count}
                  onChange={(e) => set({ min_word_count: e.target.value })} />
              </FormField>
            )}

            {/* Requires diagram */}
            <div className="flex items-center gap-3">
              <input id="ai-diagram" type="checkbox"
                checked={settings.requires_diagram}
                onChange={(e) => set({ requires_diagram: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 accent-blue-600 cursor-pointer" />
              <label htmlFor="ai-diagram" className="text-sm text-gray-700 cursor-pointer select-none">
                Requires diagram
              </label>
            </div>

            {/* Save as template */}
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center gap-3">
                <input id="ai-save-tmpl" type="checkbox"
                  checked={saveAsTemplate}
                  onChange={(e) => onSaveAsTemplateChange(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 accent-blue-600 cursor-pointer" />
                <label htmlFor="ai-save-tmpl" className="text-sm text-gray-700 cursor-pointer select-none">
                  Save current settings as template
                </label>
              </div>
              {saveAsTemplate && (
                <input type="text" className={`${inputClass} mt-2`} maxLength={100}
                  placeholder="Template name (e.g. Chapter 5 Theory)"
                  value={templateName}
                  onChange={(e) => onTemplateNameChange(e.target.value)} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Homework Form Modal ───────────────────────────────────────────────────────

function HomeworkFormModal({
  open,
  onClose,
  mode,
  initial,
  subjects,
  myClasses,
  assignments,
  filterClass,
  filterSection,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  initial?: HomeworkItem | null;
  subjects: Subject[];
  myClasses: string[];
  assignments: TeacherAssignment[];
  filterClass: string;
  filterSection: string;
  onSuccess: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<HomeworkForm>({
    ...DEFAULT_FORM,
    class_name: filterClass,
    section: filterSection,
  });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<HWTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  const token = getToken();

  // Pre-fill on edit or when filter changes
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && initial) {
      const matchedSubject = subjects.find((s) => s.name === initial.subject_name);
      setForm({
        ...DEFAULT_FORM,
        subject_id: matchedSubject?.id ?? initial.subject_id ?? '',
        custom_subject: matchedSubject ? '' : (initial.subject_name ?? ''),
        class_name: filterClass,
        section: filterSection,
        title: initial.title,
        description: initial.description ?? '',
        due_date: initial.due_date,
      });
    } else {
      setForm({
        ...DEFAULT_FORM,
        class_name: filterClass,
        section: filterSection,
      });
    }
    setError('');
  }, [open, mode, initial, filterClass, filterSection, subjects]);

  // Fetch templates when subject changes
  useEffect(() => {
    if (!open || !form.subject_id || !token) return;
    const subj = subjects.find((s) => s.id === form.subject_id);
    if (!subj) return;
    setLoadingTemplates(true);
    fetch(`${BASE_URL}/api/homework/templates?subject=${encodeURIComponent(subj.name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((j) => setTemplates((j.data as HWTemplate[]) ?? []))
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  }, [open, form.subject_id, subjects, token]);

  // Auto-suggest subject_type when subject changes
  useEffect(() => {
    if (!form.subject_id) return;
    const subj = subjects.find((s) => s.id === form.subject_id);
    if (!subj) return;
    setForm((f) => ({
      ...f,
      ai_settings: {
        ...f.ai_settings,
        subject_type: suggestSubjectType(subj.name),
      },
    }));
  }, [form.subject_id, subjects]);

  const setAI = (patch: Partial<AISettings>) =>
    setForm((f) => ({ ...f, ai_settings: { ...f.ai_settings, ...patch } }));

  function handleLoadTemplate(t: HWTemplate) {
    setForm((f) => ({
      ...f,
      ai_settings: {
        reference_answer: t.reference_answer ?? '',
        submission_type: t.submission_type ?? 'either',
        subject_type: t.subject_type ?? '',
        min_word_count: t.min_word_count ? String(t.min_word_count) : '',
        requires_diagram: t.requires_diagram ?? false,
      },
    }));
  }

  // Sections and subjects derived from teacher assignments
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === form.class_name).map((a) => a.section)
  )].sort();

  const subjectsForClassSection: Subject[] = (() => {
    if (!form.class_name || !form.section) return [];
    const assignedNames = new Set(
      assignments
        .filter((a) => a.class_name === form.class_name && a.section === form.section)
        .map((a) => a.subject.toLowerCase())
    );
    const matched = subjects.filter((s) => assignedNames.has(s.name.toLowerCase()));
    return matched.length > 0 ? matched : subjects;
  })();

  const useCustomSubject = form.subject_id === '__custom__';
  const currentSubjectName = subjects.find((s) => s.id === form.subject_id)?.name ?? '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    let effectiveSubjectId = form.subject_id;
    const isCustom = form.subject_id === '__custom__';
    const customName = form.custom_subject.trim();

    if (isCustom) {
      if (!customName) { setError('Please enter a subject name.'); return; }
      const found = subjects.find((s) => s.name.toLowerCase() === customName.toLowerCase());
      if (!found) { setError(`Subject "${customName}" is not in the school subjects list.`); return; }
      effectiveSubjectId = found.id;
    }

    if (!effectiveSubjectId || !form.class_name || !form.section || !form.title || !form.due_date) {
      setError('Please fill in all required fields.');
      return;
    }

    if (form.ai_check_enabled && form.save_as_template && !form.template_name.trim()) {
      setError('Please enter a template name to save the template.');
      return;
    }

    if (!token) return;
    setUploading(true);

    try {
      let file_url: string | undefined;

      if (form.file) {
        const fd = new FormData();
        fd.append('file', form.file);
        const uploadRes = await fetch(`${BASE_URL}/api/homework/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const uploadJson = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadJson.message ?? 'File upload failed');
        file_url = uploadJson.data?.url;
      }

      const ai = form.ai_settings;
      const payload: Record<string, unknown> = {
        subject_id: effectiveSubjectId,
        class: form.class_name,
        section: form.section,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        due_date: form.due_date,
        ...(file_url ? { file_url } : {}),
        // AI fields always sent so backend can default them
        ai_check_enabled: form.ai_check_enabled,
        ...(form.ai_check_enabled ? {
          reference_answer: ai.reference_answer.trim() || undefined,
          submission_type: ai.submission_type,
          subject_type: ai.subject_type || undefined,
          min_word_count: ai.min_word_count ? Number(ai.min_word_count) : undefined,
          requires_diagram: ai.requires_diagram,
          save_as_template: form.save_as_template,
          template_name: form.save_as_template ? form.template_name.trim() : undefined,
        } : {}),
      };

      const url = mode === 'edit' && initial
        ? `${BASE_URL}/api/homework/${initial.id}`
        : `${BASE_URL}/api/homework/create`;
      const method = mode === 'edit' ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Request failed');

      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'create' ? 'Create Homework' : 'Edit Homework'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Class / Section */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Class" htmlFor="hw-class" required>
            <select id="hw-class" className={inputClass} value={form.class_name}
              onChange={(e) => setForm((f) => ({ ...f, class_name: e.target.value, section: '', subject_id: '' }))}>
              <option value="">Select class…</option>
              {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Section" htmlFor="hw-section" required>
            <select id="hw-section" className={inputClass} value={form.section} disabled={!form.class_name}
              onChange={(e) => setForm((f) => ({ ...f, section: e.target.value, subject_id: '' }))}>
              <option value="">Select section…</option>
              {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
        </div>

        {/* Subject */}
        <FormField label="Subject" htmlFor="hw-subject" required>
          <select id="hw-subject" className={inputClass} value={form.subject_id} disabled={!form.section}
            onChange={(e) => setForm((f) => ({ ...f, subject_id: e.target.value, custom_subject: '' }))}>
            <option value="">Select subject…</option>
            {subjectsForClassSection.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="__custom__">✏️ Type a different subject…</option>
          </select>
          {useCustomSubject && (
            <input type="text" className={`${inputClass} mt-2`}
              placeholder="Enter subject name exactly as it appears in the school list…"
              value={form.custom_subject}
              onChange={(e) => setForm((f) => ({ ...f, custom_subject: e.target.value }))}
              autoFocus />
          )}
          {!form.section && (
            <p className="mt-1 text-xs text-gray-400">Select a section first</p>
          )}
        </FormField>

        {/* Title */}
        <FormField label="Title" htmlFor="hw-title" required>
          <input id="hw-title" type="text" className={inputClass} maxLength={200}
            placeholder="e.g. Chapter 5 Exercise Questions"
            value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <p className="mt-1 text-xs text-gray-400 text-right">{form.title.length}/200</p>
        </FormField>

        {/* Description */}
        <FormField label="Description" htmlFor="hw-desc">
          <textarea id="hw-desc" className={`${inputClass} resize-none`} rows={3} maxLength={2000}
            placeholder="Optional instructions or details…"
            value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          <p className="mt-1 text-xs text-gray-400 text-right">{form.description.length}/2000</p>
        </FormField>

        {/* Due Date */}
        <FormField label="Due Date" htmlFor="hw-due" required>
          <input id="hw-due" type="date" className={inputClass} min={todayISO()}
            value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
        </FormField>

        {/* Attachment */}
        <FormField label="Attachment (optional)" htmlFor="hw-file">
          <div className="flex items-center gap-3">
            <input ref={fileInputRef} id="hw-file" type="file" accept=".pdf,image/*" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && f.size > 5 * 1024 * 1024) { setError('File must be under 5 MB'); return; }
                setForm((prev) => ({ ...prev, file: f ?? null }));
              }} />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-gray-700">
              {form.file ? 'Change file' : 'Choose file'}
            </button>
            {form.file ? (
              <span className="text-sm text-gray-600 truncate max-w-xs">{form.file.name}</span>
            ) : (
              <span className="text-xs text-gray-400">PDF or image, max 5 MB</span>
            )}
          </div>
        </FormField>

        {/* ── AI Checking toggle ────────────────────────────────────────── */}
        <div className="pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Enable AI Checking</p>
              <p className="text-xs text-gray-400 mt-0.5">Automatically grade submissions using Gemini AI</p>
            </div>
            <Toggle
              checked={form.ai_check_enabled}
              onChange={(v) => setForm((f) => ({ ...f, ai_check_enabled: v }))}
              label="Enable AI Checking"
            />
          </div>

          {form.ai_check_enabled && (
            <div className="mt-3">
              <AICheckSettings
                settings={form.ai_settings}
                onChange={(s) => setForm((f) => ({ ...f, ai_settings: s }))}
                subjectName={currentSubjectName}
                subjectId={form.subject_id}
                className={form.class_name}
                section={form.section}
                token={token}
                templates={templates}
                loadingTemplates={loadingTemplates}
                onLoadTemplate={handleLoadTemplate}
                saveAsTemplate={form.save_as_template}
                onSaveAsTemplateChange={(v) => setForm((f) => ({ ...f, save_as_template: v }))}
                templateName={form.template_name}
                onTemplateNameChange={(v) => setForm((f) => ({ ...f, template_name: v }))}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={uploading}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
            {uploading && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {uploading ? 'Saving…' : mode === 'create' ? 'Create Homework' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TeacherHomeworkPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterSubject, setFilterSubject] = useState('');

  // Homework list
  const [homework, setHomework] = useState<HomeworkItem[]>([]);
  const [loadingHomework, setLoadingHomework] = useState(false);
  const [ackCounts, setAckCounts] = useState<Record<string, AckCount>>({});

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editItem, setEditItem] = useState<HomeworkItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<HomeworkItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [listError, setListError] = useState('');

  // ── Load assignments + subjects ─────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;

    Promise.all([
      assignmentsApi.list(token, user.school_id),
      fetch(`${BASE_URL}/api/teacher/subjects?assigned=true`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
    ])
      .then(([assignRes, subjectRes]) => {
        const myAssignments = assignRes.data.filter((a) => a.teacher_id === user.id);
        setAssignments(myAssignments);
        setSubjects((subjectRes.data as Subject[]) ?? []);
      })
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Derived dropdowns ───────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();
  const subjectsForFilter = [...new Set(
    assignments.filter((a) => a.class_name === filterClass && a.section === filterSection).map((a) => a.subject)
  )].sort();

  // ── Fetch homework ──────────────────────────────────────────────────────────

  const fetchHomework = useCallback(async () => {
    if (!filterClass || !filterSection || !user?.school_id) return;
    const token = getToken();
    if (!token) return;
    setLoadingHomework(true);
    setListError('');
    try {
      const qs = new URLSearchParams({
        class: filterClass,
        section: filterSection,
        school_id: user.school_id,
      });
      const res = await fetch(`${BASE_URL}/api/homework/class?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load homework');

      let list: HomeworkItem[] = (json.data as HomeworkItem[]) ?? [];
      list = list.sort((a, b) => b.due_date.localeCompare(a.due_date));
      if (filterSubject) {
        list = list.filter((h) => h.subject_name === filterSubject);
      }
      setHomework(list);

      // Fetch ack counts for each homework item
      const counts: Record<string, AckCount> = {};
      await Promise.all(
        list.map(async (hw) => {
          try {
            const ackRes = await fetch(`${BASE_URL}/api/homework/acknowledgements/${hw.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (ackRes.ok) {
              const ackJson = await ackRes.json();
              counts[hw.id] = ackJson.data as AckCount;
            }
          } catch { /* best-effort */ }
        })
      );
      setAckCounts(counts);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : 'Failed to load homework');
    } finally {
      setLoadingHomework(false);
    }
  }, [filterClass, filterSection, filterSubject, user]);

  useEffect(() => {
    fetchHomework();
  }, [fetchHomework]);

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteItem) return;
    const token = getToken();
    if (!token) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const res = await fetch(`${BASE_URL}/api/homework/${deleteItem.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Delete failed');
      setDeleteItem(null);
      fetchHomework();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Homework"
        description="Manage homework assignments for your classes"
        action={
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Homework
          </button>
        }
      />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <select className={inputClass} disabled={loadingAssignments}
            value={filterClass}
            onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setFilterSubject(''); }}>
            <option value="">{loadingAssignments ? 'Loading…' : 'All classes'}</option>
            {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={inputClass} disabled={!filterClass}
            value={filterSection}
            onChange={(e) => { setFilterSection(e.target.value); setFilterSubject(''); }}>
            <option value="">All sections</option>
            {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className={inputClass} disabled={!filterSection}
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}>
            <option value="">All subjects</option>
            {subjectsForFilter.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* ── Homework list ────────────────────────────────────────────────── */}
      {!filterClass || !filterSection ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <p className="text-sm text-gray-500">Select a class and section to view homework</p>
        </div>
      ) : loadingHomework ? (
        <HomeworkSkeleton />
      ) : listError ? (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{listError}</div>
      ) : homework.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <p className="text-sm text-gray-500 mb-3">No homework found for this class</p>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
            Create first homework
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {homework.map((hw) => (
            <HomeworkCard
              key={hw.id}
              item={hw}
              ackCount={ackCounts[hw.id] ?? null}
              onEdit={(item) => setEditItem(item)}
              onDelete={(item) => { setDeleteItem(item); setDeleteError(''); }}
              onViewStatus={(item) => router.push(`/teacher/homework/${item.id}/status`)}
            />
          ))}
        </div>
      )}

      {/* ── Create modal ─────────────────────────────────────────────────── */}
      <HomeworkFormModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        mode="create"
        subjects={subjects}
        myClasses={myClasses}
        assignments={assignments}
        filterClass={filterClass}
        filterSection={filterSection}
        onSuccess={fetchHomework}
      />

      {/* ── Edit modal ───────────────────────────────────────────────────── */}
      <HomeworkFormModal
        open={!!editItem}
        onClose={() => setEditItem(null)}
        mode="edit"
        initial={editItem}
        subjects={subjects}
        myClasses={myClasses}
        assignments={assignments}
        filterClass={filterClass}
        filterSection={filterSection}
        onSuccess={() => { setEditItem(null); fetchHomework(); }}
      />

      {/* ── Delete confirmation modal ────────────────────────────────────── */}
      <Modal open={!!deleteItem} onClose={() => setDeleteItem(null)} title="Delete Homework" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Delete this homework?{' '}
            <span className="font-semibold text-gray-900">{deleteItem?.title}</span>
            <br />
            <span className="text-gray-500">Students will no longer see it.</span>
          </p>
          {deleteError && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{deleteError}</div>
          )}
          <div className="flex justify-end gap-3">
            <button onClick={() => setDeleteItem(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={deleting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg transition-colors">
              {deleting && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
