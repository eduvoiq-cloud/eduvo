'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import {
  assignmentsApi, testsApi,
  type TeacherAssignment, type MCQQuestion, type TheoryQuestion, type TestQuestion,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestDetails {
  title: string;
  subject: string;
  class_name: string;
  section: string;
  term: string;
  exam_type: ExamTypeValue;
  date: string;
  start_time: string;
  end_time: string;
  time_limit_minutes: string;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  // New fields from daily test migration
  board: string;
  chapter: string;
  language: string;
  contributes_to_streak: boolean;
  // Web proctoring
  require_camera: boolean;
  allow_web_attempt: boolean;
  // AI generation
  use_ai: boolean;
  ai_topic: string;
  ai_count: number;
  ai_difficulty: 'mixed' | 'easy' | 'medium' | 'hard' | 'custom';
  ai_easy_count: number;
  ai_medium_count: number;
  ai_hard_count: number;
}

interface MCQDraft {
  type: 'mcq';
  text: string;
  marks: string;
  options: [string, string, string, string];
  correct_option: number; // 0-3
}

interface TheoryDraft {
  type: 'theory';
  text: string;
  marks: string;
}

type QuestionDraft = MCQDraft | TheoryDraft;

interface StudentOption {
  id: string;
  full_name: string;
  roll_number?: string;
}

// ── Chapter library types ─────────────────────────────────────────────────────

interface ChapterOption {
  id: string;
  chapter_number: number;
  chapter_name: string;
  topics: string;
}

// Topic source mode for the AI section
type TopicSourceMode = 'manual' | 'library';

// Library selection state
interface LibrarySelection {
  board: string;
  subject: string;
  chapterId: string;
  chapterNumber: number;
  chapterName: string;
  allTopics: string[];       // parsed from chapter.topics
  checkedTopics: Set<string>;
  customTopicChecked: boolean;
  customTopicText: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TERMS = ['term_1', 'term_2', 'term_3'] as const;
const TERM_LABELS: Record<string, string> = { term_1: 'Term 1', term_2: 'Term 2', term_3: 'Term 3' };


const EXAM_TYPES = ['class_test', 'unit_test', 'mid_term', 'final', 'quiz', 'midterm', 'assignment', 'project'] as const;
type ExamTypeValue = typeof EXAM_TYPES[number];
const EXAM_TYPE_LABELS: Record<ExamTypeValue, string> = {
  class_test: 'Class Test',
  unit_test: 'Unit Test',
  mid_term: 'Mid Term',
  final: 'Final',
  quiz: 'Quiz',
  midterm: 'Midterm',
  assignment: 'Assignment',
  project: 'Project',
};

const BOARDS = ['GSEB', 'CBSE', 'ICSE', 'MSBSHSE', 'RBSE', 'BSEB', 'MPBSE', 'IB', 'IGCSE'] as const;
const LANGUAGES = ['English', 'Gujarati', 'Hindi', 'Marathi', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Punjabi', 'Sanskrit'] as const;

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_DETAILS: TestDetails = {
  title: '', subject: '', class_name: '', section: '', term: '', exam_type: 'class_test',
  date: getTodayDateString(), start_time: '', end_time: '', time_limit_minutes: '', shuffle_questions: true, shuffle_options: true,
  board: 'GSEB', chapter: '', language: 'English', contributes_to_streak: true,
  allow_web_attempt: false,
  require_camera: false,
  use_ai: false, ai_topic: '', ai_count: 10, ai_difficulty: 'mixed',
  ai_easy_count: 4, ai_medium_count: 4, ai_hard_count: 2,
};

const EMPTY_MCQ: MCQDraft = {
  type: 'mcq', text: '', marks: '1', options: ['', '', '', ''], correct_option: 0,
};

const EMPTY_THEORY: TheoryDraft = { type: 'theory', text: '', marks: '5' };

// ── Step indicator ────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: 'Test Details' },
    { n: 2, label: 'Add Questions' },
    { n: 3, label: 'Review & Publish' },
  ];
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center">
          <div className="flex flex-col items-center">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
              current === s.n
                ? 'bg-blue-600 text-white'
                : current > s.n
                ? 'bg-green-500 text-white'
                : 'bg-gray-200 text-gray-500'
            }`}>
              {current > s.n ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : s.n}
            </div>
            <span className={`mt-1.5 text-xs font-medium whitespace-nowrap ${
              current === s.n ? 'text-blue-600' : current > s.n ? 'text-green-600' : 'text-gray-400'
            }`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-0.5 w-16 sm:w-24 mx-2 mb-4 transition-colors ${current > s.n ? 'bg-green-400' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
        checked ? 'bg-blue-600' : 'bg-gray-300'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`} />
    </button>
  );
}

// ── Question badge ────────────────────────────────────────────────────────────

function QTypeBadge({ type }: { type: 'mcq' | 'theory' }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
      type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
    }`}>
      {type === 'mcq' ? 'MCQ' : 'Theory'}
    </span>
  );
}

// ── MCQ Question form ─────────────────────────────────────────────────────────

interface MCQFormProps {
  draft: MCQDraft;
  onChange: (d: MCQDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string;
}

function MCQForm({ draft, onChange, onSave, onCancel, error }: MCQFormProps) {
  return (
    <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <QTypeBadge type="mcq" /> MCQ Question
        </h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <FormField label="Question Text" htmlFor="mcq-text" required>
        <textarea
          id="mcq-text" rows={3}
          className={`${inputClass} resize-none`}
          placeholder="Enter your question here…"
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </FormField>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Options <span className="text-red-500">*</span></p>
        <p className="text-xs text-gray-500">Click the letter button to mark the correct answer.</p>
        {(['A', 'B', 'C', 'D'] as const).map((letter, idx) => (
          <div key={letter} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onChange({ ...draft, correct_option: idx })}
              aria-label={`Mark option ${letter} as correct`}
              className={`w-8 h-8 rounded-full text-xs font-bold shrink-0 transition-colors border-2 ${
                draft.correct_option === idx
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'
              }`}
            >
              {letter}
            </button>
            <input
              type="text"
              className={inputClass}
              placeholder={`Option ${letter}`}
              value={draft.options[idx]}
              onChange={(e) => {
                const opts = [...draft.options] as [string, string, string, string];
                opts[idx] = e.target.value;
                onChange({ ...draft, options: opts });
              }}
            />
          </div>
        ))}
      </div>

      <div className="flex items-end gap-4">
        <div className="w-32">
          <FormField label="Marks" htmlFor="mcq-marks" required>
            <input
              id="mcq-marks" type="number" min={1} step={0.5}
              className={inputClass}
              value={draft.marks}
              onChange={(e) => onChange({ ...draft, marks: e.target.value })}
            />
          </FormField>
        </div>
        <div className="flex gap-2 pb-0.5">
          <button type="button" onClick={onCancel}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onSave}
            className="px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
            Save Question
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Theory Question form ──────────────────────────────────────────────────────

interface TheoryFormProps {
  draft: TheoryDraft;
  onChange: (d: TheoryDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string;
}

function TheoryForm({ draft, onChange, onSave, onCancel, error }: TheoryFormProps) {
  return (
    <div className="border border-purple-200 bg-purple-50/40 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <QTypeBadge type="theory" /> Theory Question
        </h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <FormField label="Question Text" htmlFor="theory-text" required>
        <textarea
          id="theory-text" rows={3}
          className={`${inputClass} resize-none`}
          placeholder="Enter your question here…"
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </FormField>

      <div className="flex items-end gap-4">
        <div className="w-32">
          <FormField label="Max Marks" htmlFor="theory-marks" required>
            <input
              id="theory-marks" type="number" min={1} step={1}
              className={inputClass}
              value={draft.marks}
              onChange={(e) => onChange({ ...draft, marks: e.target.value })}
            />
          </FormField>
        </div>
        <div className="flex gap-2 pb-0.5">
          <button type="button" onClick={onCancel}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onSave}
            className="px-4 py-2.5 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors">
            Save Question
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Saved question row ────────────────────────────────────────────────────────

interface QuestionRowProps {
  q: QuestionDraft;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}

function QuestionRow({ q, index, onEdit, onDelete }: QuestionRowProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-gray-300 transition-colors">
      <span className="text-xs font-bold text-gray-400 mt-0.5 w-5 shrink-0">Q{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <QTypeBadge type={q.type} />
          <span className="text-xs text-gray-500">{q.marks} mark{parseFloat(q.marks) !== 1 ? 's' : ''}</span>
          {q.type === 'mcq' && (
            <span className="text-xs text-green-600 font-medium">
              Correct: {String.fromCharCode(65 + (q as MCQDraft).correct_option)}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-800 line-clamp-2">{q.text}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onEdit}
          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          aria-label="Edit question">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button type="button" onClick={onDelete}
          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          aria-label="Delete question">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_TERM_KEY        = 'eduvo_last_term';
const LS_EXAM_TYPE_KEY   = 'eduvo_last_exam_type';
const LS_START_TIME_KEY  = 'eduvo_last_start_time';
const LS_END_TIME_KEY    = 'eduvo_last_end_time';

function readLS(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writeLS(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ── Subject fuzzy-match helper ────────────────────────────────────────────────
// Maps a teacher assignment subject name (free-text, e.g. "Maths") to the
// closest canonical name in the chapter library (e.g. "Mathematics").
// Returns the matched library subject string, or null if nothing close enough.

const SUBJECT_ALIASES: Record<string, string[]> = {
  mathematics: ['maths', 'math', 'mathematics', 'ganit'],
  science:     ['science', 'vigyan', 'general science', 'natural science', 'evs', 'environmental science'],
  english:     ['english', 'angrezi', 'english language', 'english literature'],
  hindi:       ['hindi', 'hindi language', 'hindi literature'],
  gujarati:    ['gujarati', 'gujarati language', 'gujarati literature'],
  sanskrit:    ['sanskrit'],
  'social science': ['social science', 'social studies', 'sst', 'samajik vigyan', 'history', 'geography', 'civics'],
  marathi:     ['marathi'],
  bengali:     ['bengali', 'bangla'],
  tamil:       ['tamil'],
  telugu:      ['telugu'],
  kannada:     ['kannada'],
  punjabi:     ['punjabi'],
  physics:     ['physics', 'bhautiki'],
  chemistry:   ['chemistry', 'rasayan'],
  biology:     ['biology', 'jeev vigyan', 'life science'],
  'computer science': ['computer science', 'cs', 'computer', 'computers', 'information technology', 'it'],
  economics:   ['economics', 'arthashastra'],
  history:     ['history', 'itihas'],
  geography:   ['geography', 'bhugol'],
  civics:      ['civics', 'political science', 'pol science', 'pol. science'],
  accountancy: ['accountancy', 'accounts', 'accounting'],
  'business studies': ['business studies', 'business', 'commerce'],
};

function fuzzyMatchSubject(assignedName: string, librarySubjects: string[]): string | null {
  if (!assignedName || librarySubjects.length === 0) return null;
  const needle = assignedName.trim().toLowerCase();

  // 1. Exact match (case-insensitive)
  const exact = librarySubjects.find((s) => s.toLowerCase() === needle);
  if (exact) return exact;

  // 2. Library subject contains the assignment name or vice versa
  const partial = librarySubjects.find(
    (s) => s.toLowerCase().includes(needle) || needle.includes(s.toLowerCase())
  );
  if (partial) return partial;

  // 3. Alias table lookup
  for (const [canonical, aliases] of Object.entries(SUBJECT_ALIASES)) {
    if (aliases.includes(needle)) {
      const lib = librarySubjects.find((s) => s.toLowerCase() === canonical);
      if (lib) return lib;
    }
  }

  return null;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CreateTestPage() {
  const { user } = useAuth();
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — test details (initialised with last-used values from localStorage)
  const [details, setDetails] = useState<TestDetails>(() => {
    const lastTerm      = readLS(LS_TERM_KEY);
    const lastExamType  = readLS(LS_EXAM_TYPE_KEY) as ExamTypeValue | '';
    const lastStartTime = readLS(LS_START_TIME_KEY);
    const lastEndTime   = readLS(LS_END_TIME_KEY);
    return {
      ...EMPTY_DETAILS,
      term:       lastTerm     || EMPTY_DETAILS.term,
      exam_type:  (lastExamType && (EXAM_TYPES as readonly string[]).includes(lastExamType))
                    ? (lastExamType as ExamTypeValue)
                    : EMPTY_DETAILS.exam_type,
      start_time: lastStartTime || EMPTY_DETAILS.start_time,
      end_time:   lastEndTime   || EMPTY_DETAILS.end_time,
    };
  });
  const [detailsError, setDetailsError] = useState('');

  // Persist last-used term, exam type and test-window times to localStorage
  useEffect(() => { if (details.term)       writeLS(LS_TERM_KEY,       details.term);      }, [details.term]);
  useEffect(() => { if (details.exam_type)  writeLS(LS_EXAM_TYPE_KEY,  details.exam_type); }, [details.exam_type]);
  useEffect(() => {                          writeLS(LS_START_TIME_KEY, details.start_time); }, [details.start_time]);
  useEffect(() => {                          writeLS(LS_END_TIME_KEY,   details.end_time);   }, [details.end_time]);

  // Step 2 — questions
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [activeForm, setActiveForm] = useState<'mcq' | 'theory' | null>(null);
  const [mcqDraft, setMcqDraft] = useState<MCQDraft>({ ...EMPTY_MCQ });
  const [theoryDraft, setTheoryDraft] = useState<TheoryDraft>({ ...EMPTY_THEORY });
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [questionError, setQuestionError] = useState('');
  const [questionsError, setQuestionsError] = useState('');

  // Step 3 — restrictions and publish
  const [blockRestrictions, setBlockRestrictions] = useState(false);
  const [classStudents, setClassStudents] = useState<StudentOption[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [blockedStudentIds, setBlockedStudentIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [publishError, setPublishError] = useState('');

  // AI generation state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // AI source mode: 'topic' (default) or 'pdf'
  const [aiSource, setAiSource] = useState<'topic' | 'pdf'>('topic');

  // PDF upload state (for "Generate from PDF" mode)
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUploadState, setPdfUploadState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [pdfExtractionId, setPdfExtractionId] = useState('');
  const [pdfUploadError, setPdfUploadError] = useState('');
  const [pdfTotalChars, setPdfTotalChars] = useState(0);
  const [pdfGenerateStage, setPdfGenerateStage] = useState('');
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // Assignments for dropdowns
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Chapter library state ───────────────────────────────────────────────────
  // Topic source mode (applies inside the AI section, "From Topic" only)
  const [topicSourceMode, setTopicSourceMode] = useState<TopicSourceMode>('library');

  // Library cascading dropdowns state
  const [libSubjects, setLibSubjects] = useState<string[]>([]);
  const [libSubjectsLoading, setLibSubjectsLoading] = useState(false);
  const [libChapters, setLibChapters] = useState<ChapterOption[]>([]);
  const [libChaptersLoading, setLibChaptersLoading] = useState(false);

  const [libSelection, setLibSelection] = useState<LibrarySelection>({
    board: details.board || 'CBSE',
    subject: '',
    chapterId: '',
    chapterNumber: 0,
    chapterName: '',
    allTopics: [],
    checkedTopics: new Set<string>(),
    customTopicChecked: false,
    customTopicText: '',
  });

  // When the teacher picks a subject in the top section, mirror it into the
  // library selection so they don't have to pick it again in the AI section.
  // Uses fuzzy matching so "Maths" maps to "Mathematics", etc.
  useEffect(() => {
    if (!details.subject || libSubjects.length === 0) return;
    setLibSelection((prev) => {
      const matched = fuzzyMatchSubject(details.subject, libSubjects);
      if (!matched) return prev;
      if (prev.subject === matched) return prev; // already set
      // Reset chapter when subject changes
      return {
        ...prev,
        subject: matched,
        chapterId: '',
        chapterNumber: 0,
        chapterName: '',
        allTopics: [],
        checkedTopics: new Set(),
        customTopicChecked: false,
        customTopicText: '',
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details.subject, libSubjects]);

  // chapter_library_id and selected_topics stored after generation, passed to create
  const [savedChapterLibraryId, setSavedChapterLibraryId] = useState<string | null>(null);
  const [savedSelectedTopics, setSavedSelectedTopics] = useState<string | null>(null);

  // ── Fetch teacher assignments ───────────────────────────────────────────────

  const fetchAssignments = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    try {
      const res = await assignmentsApi.list(token, user.school_id);
      setAssignments(res.data.filter((a) => a.teacher_id === user.id));
    } catch { /* silent — dropdowns will be empty */ }
    finally { setLoadingAssignments(false); }
  }, [user]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // ── Library: fetch subjects when board or class changes ────────────────────

  const fetchLibSubjects = useCallback(async (board: string, classNum: string) => {
    if (!board || !classNum) { setLibSubjects([]); return; }
    const token = getToken();
    if (!token) return;
    setLibSubjectsLoading(true);
    setLibSubjects([]);
    try {
      const qs = new URLSearchParams({ board, class: classNum });
      const res = await fetch(`${BASE_URL}/api/chapter-library/subjects?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { success: boolean; data: { subjects: string[] } };
      const subjects = json.success ? (json.data.subjects ?? []) : [];
      setLibSubjects(subjects);
      // Auto-resolve library subject from the teacher's selected subject (fuzzy match)
      if (details.subject && subjects.length > 0) {
        const matched = fuzzyMatchSubject(details.subject, subjects);
        if (matched) {
          setLibSelection((prev) => {
            if (prev.subject === matched) return prev;
            return {
              ...prev,
              subject: matched,
              chapterId: '',
              chapterNumber: 0,
              chapterName: '',
              allTopics: [],
              checkedTopics: new Set(),
              customTopicChecked: false,
              customTopicText: '',
            };
          });
        }
      }
    } catch { setLibSubjects([]); }
    finally { setLibSubjectsLoading(false); }
  }, []);

  const fetchLibChapters = useCallback(async (board: string, classNum: string, subject: string) => {
    if (!board || !classNum || !subject) { setLibChapters([]); return; }
    const token = getToken();
    if (!token) return;
    setLibChaptersLoading(true);
    setLibChapters([]);
    try {
      const qs = new URLSearchParams({ board, class: classNum, subject });
      const res = await fetch(`${BASE_URL}/api/chapter-library/chapters?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { success: boolean; data: { chapters: ChapterOption[] } };
      setLibChapters(json.success ? (json.data.chapters ?? []) : []);
    } catch { setLibChapters([]); }
    finally { setLibChaptersLoading(false); }
  }, []);

  // ── Auto-fetch library subjects when class is selected (library mode is always active now) ──
  useEffect(() => {
    if (details.class_name && libSelection.board) {
      fetchLibSubjects(libSelection.board, details.class_name);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details.class_name, libSelection.board]);

  // ── Auto-fetch chapters when library subject is set ─────────────────────────
  useEffect(() => {
    if (libSelection.subject && details.class_name && libSelection.board) {
      fetchLibChapters(libSelection.board, details.class_name, libSelection.subject);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libSelection.subject, details.class_name, libSelection.board]);

  // ── Fetch students for restriction selection ────────────────────────────────

  const fetchClassStudents = useCallback(async () => {
    if (!details.class_name || !details.section) return;
    const token = getToken();
    if (!token) return;
    setLoadingStudents(true);
    try {
      const qs = new URLSearchParams({
        class_name: details.class_name,
        section: details.section,
        limit: '0',
      });
      const res = await fetch(`${BASE_URL}/api/students?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      const students = Array.isArray(json.data) ? json.data : (json.data?.data ?? []);
      setClassStudents(students.map((s: { id: string; full_name: string; roll_number?: string }) => ({
        id: s.id,
        full_name: s.full_name,
        roll_number: s.roll_number,
      })));
    } catch {
      // silent
    } finally {
      setLoadingStudents(false);
    }
  }, [details.class_name, details.section]);

  // Load students when entering step 3
  useEffect(() => {
    if (step === 3) fetchClassStudents();
  }, [step, fetchClassStudents]);

  // ── Derived dropdown options ────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();

  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === details.class_name).map((a) => a.section)
  )].sort();

  const subjectsForClassSection = [...new Set(
    assignments
      .filter((a) => a.class_name === details.class_name && a.section === details.section)
      .map((a) => a.subject)
  )].sort();

  // ── Derived totals ──────────────────────────────────────────────────────────

  const totalMarks = questions.reduce((sum, q) => sum + parseFloat(q.marks || '0'), 0);
  const mcqCount = questions.filter((q) => q.type === 'mcq').length;
  const theoryCount = questions.filter((q) => q.type === 'theory').length;

  // ── PDF upload handler ──────────────────────────────────────────────────

  async function handlePdfUpload(file: File) {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!['.pdf', '.docx', '.txt'].includes(ext)) {
      setPdfUploadError('Only .pdf, .docx, and .txt files are allowed.'); return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPdfUploadError('File too large. Maximum 5 MB.'); return;
    }
    setPdfFile(file);
    setPdfUploadError('');
    setPdfUploadState('uploading');
    const token = getToken();
    if (!token) { setPdfUploadState('error'); setPdfUploadError('Session expired.'); return; }
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${BASE_URL}/api/ai/upload-and-extract`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Upload failed');
      setPdfExtractionId(json.data.extraction_id);
      setPdfTotalChars(json.data.total_chars);
      setPdfUploadState('done');
    } catch (e: unknown) {
      setPdfUploadState('error');
      setPdfUploadError(e instanceof Error ? e.message : 'Upload failed.');
    }
  }

  // ── AI generate from PDF ─────────────────────────────────────────────────

  async function handleAIGenerateFromPdf() {
    setGenerateError('');
    setPdfGenerateStage('');
    const { subject, class_name, ai_count } = details;
    if (!class_name) { setGenerateError('Please select a class first.'); return; }
    if (!subject) { setGenerateError('Please select a subject first.'); return; }
    if (!pdfExtractionId) { setGenerateError('Please upload a PDF first.'); return; }

    setGenerating(true);
    const token = getToken();
    if (!token) { setGenerating(false); setGenerateError('Session expired.'); return; }
    try {
      const res = await fetch(`${BASE_URL}/api/ai/generate-stream`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extraction_id: pdfExtractionId,
          subject: subject.slice(0, 50),
          class_level: class_name.slice(0, 20),
          difficulty: details.ai_difficulty === 'mixed' || details.ai_difficulty === 'custom' ? 'medium' : details.ai_difficulty,
          mcq_count: ai_count,
          theory_count: 0,
        }),
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string }).message ?? 'Generation failed');
      }

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(raw); } catch { continue; }
          if (event.error) throw new Error(String(event.error));
          if (event.stage) setPdfGenerateStage(String(event.stage));
          if (event.done) {
            type GeneratedQ = {
              question_text?: string; question?: string;
              option_a: string; option_b: string; option_c: string; option_d: string;
              correct_option: 'a'|'b'|'c'|'d'; marks: number;
            };
            const generated: MCQDraft[] = ((event.mcq_questions ?? []) as GeneratedQ[]).map((q) => ({
              type: 'mcq' as const,
              text: q.question_text ?? q.question ?? '',
              marks: String(q.marks ?? 1),
              options: [q.option_a, q.option_b, q.option_c, q.option_d] as [string,string,string,string],
              correct_option: ['a','b','c','d'].indexOf(q.correct_option),
            }));
            setQuestions(generated);
            if (!details.title.trim()) {
              setDetails((d) => ({ ...d, title: `${subject} — ${pdfFile?.name.replace(/\.[^.]+$/, '') ?? 'PDF'}` }));
            }
            setStep(2);
          }
        }
      }
    } catch (e: unknown) {
      setGenerateError(e instanceof Error ? e.message : 'Generation failed. Try again.');
    } finally {
      setGenerating(false);
      setPdfGenerateStage('');
    }
  }

  // ── Compute final topics string for library mode ────────────────────────────

  function getLibraryFinalTopics(): string {
    const topics = [...libSelection.checkedTopics];
    if (libSelection.customTopicChecked && libSelection.customTopicText.trim()) {
      topics.push(libSelection.customTopicText.trim());
    }
    return topics.join(', ');
  }

  // ── AI generate questions ───────────────────────────────────────────────

  async function handleAIGenerate() {
    setGenerateError('');
    const { title, subject, class_name, ai_topic, board, chapter, language,
            ai_count, ai_difficulty, ai_easy_count, ai_medium_count, ai_hard_count } = details;
    if (!class_name) { setGenerateError('Please select a class first.'); return; }
    if (!subject) { setGenerateError('Please select a subject first.'); return; }

    // Validate based on topic source mode
    if (topicSourceMode === 'manual') {
      if (!ai_topic.trim()) { setGenerateError('Please enter a topic.'); return; }
    } else {
      // Library mode
      if (!libSelection.chapterId) { setGenerateError('Please select a chapter from the library.'); return; }
    }

    setGenerating(true);
    try {
      const token = getToken();

      const isLibrary = topicSourceMode === 'library';
      const finalTopics = isLibrary ? getLibraryFinalTopics() : '';

      const body: Record<string, unknown> = {
        class: class_name,
        subject: isLibrary ? libSelection.subject : subject,
        topic: isLibrary ? finalTopics : ai_topic.trim(),
        board: isLibrary ? libSelection.board : (board || 'GSEB'),
        chapter: chapter || '',
        language: language || 'English',
        count: ai_count,
        difficulty_mode: ai_difficulty,
        ...(ai_difficulty === 'custom' ? {
          easy_count: ai_easy_count,
          medium_count: ai_medium_count,
          hard_count: ai_hard_count,
        } : {}),
        // Library-specific fields
        ...(isLibrary ? {
          chapter_library_id: libSelection.chapterId,
          chapter_number: libSelection.chapterNumber,
          chapter_name: libSelection.chapterName,
          selected_topics: finalTopics,
        } : {}),
      };

      const res = await fetch(`${BASE_URL}/api/tests/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Generation failed');

      // Map returned questions to MCQDraft format
      type GeneratedQ = {
        question_text: string; option_a: string; option_b: string;
        option_c: string; option_d: string; correct_option: 'a'|'b'|'c'|'d'; marks: number;
      };
      const generated: MCQDraft[] = (json.data.questions as GeneratedQ[]).map((q) => ({
        type: 'mcq' as const,
        text: q.question_text,
        marks: String(q.marks ?? 1),
        options: [q.option_a, q.option_b, q.option_c, q.option_d] as [string,string,string,string],
        correct_option: ['a','b','c','d'].indexOf(q.correct_option),
      }));

      setQuestions(generated);

      // Store library references for use when saving the test
      if (isLibrary) {
        setSavedChapterLibraryId(json.data.chapter_library_id ?? libSelection.chapterId);
        setSavedSelectedTopics(json.data.selected_topics ?? finalTopics);
      } else {
        setSavedChapterLibraryId(null);
        setSavedSelectedTopics(null);
      }

      // Auto-fill title
      if (!title.trim()) {
        const titleText = isLibrary
          ? `${libSelection.subject} — Ch. ${libSelection.chapterNumber}: ${libSelection.chapterName}`
          : `${subject} — ${ai_topic.trim()}`;
        setDetails((d) => ({ ...d, title: titleText }));
      }
      setStep(2);
    } catch (e: unknown) {
      setGenerateError(e instanceof Error ? e.message : 'AI generation failed. Try again or create manually.');
    } finally {
      setGenerating(false);
    }
  }

  // ── Step 1 validation ───────────────────────────────────────────────────────

  function handleNextFromStep1() {
    setDetailsError('');
    const { title, subject, class_name, section, term, date } = details;
    if (!title.trim()) { setDetailsError('Test title is required.'); return; }
    if (!class_name) { setDetailsError('Please select a class.'); return; }
    if (!section) { setDetailsError('Please select a section.'); return; }
    if (!subject) { setDetailsError('Please select a subject.'); return; }
    if (!term) { setDetailsError('Please select a term.'); return; }
    if (!date) { setDetailsError('Please select a test date.'); return; }
    setStep(2);
  }

  // ── Question save logic ─────────────────────────────────────────────────────

  function validateAndSaveMCQ() {
    setQuestionError('');
    if (!mcqDraft.text.trim()) { setQuestionError('Question text is required.'); return; }
    if (mcqDraft.options.some((o) => !o.trim())) { setQuestionError('All 4 options are required.'); return; }
    if (!mcqDraft.marks || parseFloat(mcqDraft.marks) <= 0) { setQuestionError('Marks must be greater than 0.'); return; }

    if (editingIndex !== null) {
      setQuestions((prev) => prev.map((q, i) => i === editingIndex ? { ...mcqDraft } : q));
      setEditingIndex(null);
    } else {
      setQuestions((prev) => [...prev, { ...mcqDraft }]);
    }
    setMcqDraft({ ...EMPTY_MCQ });
    setActiveForm(null);
  }

  function validateAndSaveTheory() {
    setQuestionError('');
    if (!theoryDraft.text.trim()) { setQuestionError('Question text is required.'); return; }
    if (!theoryDraft.marks || parseFloat(theoryDraft.marks) <= 0) { setQuestionError('Max marks must be greater than 0.'); return; }

    if (editingIndex !== null) {
      setQuestions((prev) => prev.map((q, i) => i === editingIndex ? { ...theoryDraft } : q));
      setEditingIndex(null);
    } else {
      setQuestions((prev) => [...prev, { ...theoryDraft }]);
    }
    setTheoryDraft({ ...EMPTY_THEORY });
    setActiveForm(null);
  }

  function handleEditQuestion(idx: number) {
    const q = questions[idx];
    setEditingIndex(idx);
    setQuestionError('');
    if (q.type === 'mcq') {
      setMcqDraft({ ...(q as MCQDraft) });
      setActiveForm('mcq');
    } else {
      setTheoryDraft({ ...(q as TheoryDraft) });
      setActiveForm('theory');
    }
  }

  function handleDeleteQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
    if (editingIndex === idx) { setActiveForm(null); setEditingIndex(null); }
  }

  function handleCancelForm() {
    setActiveForm(null);
    setEditingIndex(null);
    setQuestionError('');
    setMcqDraft({ ...EMPTY_MCQ });
    setTheoryDraft({ ...EMPTY_THEORY });
  }

  function handleNextFromStep2() {
    setQuestionsError('');
    if (questions.length === 0) { setQuestionsError('Add at least one question before continuing.'); return; }
    if (activeForm !== null) { setQuestionsError('Please save or cancel the current question form first.'); return; }
    setStep(3);
  }

  // ── Publish ─────────────────────────────────────────────────────────────────

  async function handlePublish() {
    setPublishError('');
    const token = getToken();
    if (!token) { setPublishError('Session expired. Please log in again.'); return; }

    // Validate test window: "Closes at" must differ from "Opens at"
    if (details.start_time && details.end_time && details.start_time === details.end_time) {
      setPublishError('"Closes at" and "Opens at" cannot be the same time. If you only want to set an open time, leave "Closes at" empty.');
      return;
    }

    setSubmitting(true);
    try {
      const builtQuestions: TestQuestion[] = questions.map((q) => {
        if (q.type === 'mcq') {
          const mq = q as MCQDraft;
          return {
            type: 'mcq' as const,
            text: mq.text,
            marks: parseFloat(mq.marks),
            options: mq.options.map((o) => ({ text: o })),
            correct_option: mq.correct_option,
          } satisfies MCQQuestion;
        } else {
          const tq = q as TheoryDraft;
          return {
            type: 'theory' as const,
            text: tq.text,
            marks: parseFloat(tq.marks),
          } satisfies TheoryQuestion;
        }
      });

      const created = await testsApi.create(token, {
        title: details.title.trim(),
        subject: details.subject,
        class_name: details.class_name,
        section: details.section,
        term: details.term,
        exam_type: details.exam_type,
        date: details.date,
        available_from: details.start_time || null,
        available_until: details.end_time || null,
        time_limit_minutes: details.time_limit_minutes ? parseInt(details.time_limit_minutes) : undefined,
        shuffle_questions: details.shuffle_questions,
        shuffle_options: details.shuffle_options,
        board: details.board || null,
        chapter: details.chapter || null,
        language: details.language || null,
        contributes_to_streak: details.contributes_to_streak,
        // Chapter library fields — set if teacher used library mode, null otherwise
        chapter_library_id: savedChapterLibraryId ?? null,
        selected_topics: savedSelectedTopics ?? null,
        require_camera: details.require_camera,
        allow_web_attempt: details.allow_web_attempt,
        questions: builtQuestions,
      });

      // Save restrictions if any students are blocked
      if (blockRestrictions && blockedStudentIds.size > 0 && created.data?.id) {
        await fetch(`${BASE_URL}/api/tests/${created.data.id}/restrictions`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocked_student_ids: Array.from(blockedStudentIds) }),
        });
      }

      // Auto-redirect to tests list with success message
      router.push('/teacher/tests?created=1');
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Failed to publish test. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Create Test"
        description="Build a new test with MCQ and theory questions"
        action={
          <button
            onClick={() => router.push('/teacher/tests')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Tests
          </button>
        }
      />

      <StepIndicator current={step} />

      {/* ── Step 1: Test Details ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
            <h2 className="text-sm font-semibold text-gray-900">Test Details</h2>

            {detailsError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {detailsError}
              </div>
            )}

            <FormField label="Test Title" htmlFor="d-title" required>
              <input
                id="d-title" type="text" className={inputClass}
                placeholder="e.g. Mid-Term Mathematics Test"
                value={details.title}
                onChange={(e) => setDetails((d) => ({ ...d, title: e.target.value }))}
              />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Class" htmlFor="d-class" required>
                <select
                  id="d-class" className={inputClass}
                  disabled={loadingAssignments}
                  value={details.class_name}
                  onChange={(e) => setDetails((d) => ({ ...d, class_name: e.target.value, section: '', subject: '' }))}
                >
                  <option value="">{loadingAssignments ? 'Loading…' : 'Select class…'}</option>
                  {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>

              <FormField label="Section" htmlFor="d-section" required>
                <select
                  id="d-section" className={inputClass}
                  disabled={!details.class_name}
                  value={details.section}
                  onChange={(e) => setDetails((d) => ({ ...d, section: e.target.value, subject: '' }))}
                >
                  <option value="">Select section…</option>
                  {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Subject" htmlFor="d-subject" required>
                <select
                  id="d-subject" className={inputClass}
                  disabled={!details.section}
                  value={details.subject}
                  onChange={(e) => setDetails((d) => ({ ...d, subject: e.target.value }))}
                >
                  <option value="">Select subject…</option>
                  {subjectsForClassSection.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </FormField>

              <FormField label="Term" htmlFor="d-term" required>
                <select
                  id="d-term" className={inputClass}
                  value={details.term}
                  onChange={(e) => setDetails((d) => ({ ...d, term: e.target.value }))}
                >
                  <option value="">Select term…</option>
                  {TERMS.map((t) => <option key={t} value={t}>{TERM_LABELS[t]}</option>)}
                </select>
              </FormField>
            </div>

            <FormField label="Test Type" htmlFor="d-exam-type" required>
              <select
                id="d-exam-type" className={inputClass}
                value={details.exam_type}
                onChange={(e) => setDetails((d) => ({ ...d, exam_type: e.target.value as ExamTypeValue }))}
              >
                {EXAM_TYPES.map((t) => <option key={t} value={t}>{EXAM_TYPE_LABELS[t]}</option>)}
              </select>
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Test Date" htmlFor="d-date" required>
                <input
                  id="d-date" type="date" className={inputClass}
                  min={new Date().toISOString().slice(0, 10)}
                  value={details.date}
                  onChange={(e) => setDetails((d) => ({ ...d, date: e.target.value, start_time: '', end_time: '' }))}
                />
              </FormField>

              <FormField label="Time Limit (minutes)" htmlFor="d-time">
                <input
                  id="d-time" type="number" min={1} step={1} className={inputClass}
                  placeholder="Optional"
                  value={details.time_limit_minutes}
                  onChange={(e) => setDetails((d) => ({ ...d, time_limit_minutes: e.target.value }))}
                />
              </FormField>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 mb-1.5">Test Window <span className="text-xs font-normal text-gray-400">(optional — restrict when students can start)</span></p>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Opens at" htmlFor="d-start-time">
                  <input
                    id="d-start-time" type="time" className={inputClass}
                    min={details.date === new Date().toISOString().slice(0, 10)
                      ? new Date().toTimeString().slice(0, 5)
                      : undefined}
                    value={details.start_time}
                    onChange={(e) => {
                      const val = e.target.value;
                      const today = new Date().toISOString().slice(0, 10);
                      if (details.date === today && val) {
                        const now = new Date().toTimeString().slice(0, 5);
                        if (val < now) { setDetailsError('"Opens at" cannot be in the past.'); return; }
                      }
                      setDetailsError('');
                      setDetails((d) => ({ ...d, start_time: val }));
                    }}
                  />
                </FormField>
                <FormField label="Closes at" htmlFor="d-end-time">
                  <input
                    id="d-end-time" type="time" className={inputClass}
                    value={details.end_time}
                    onChange={(e) => setDetails((d) => ({ ...d, end_time: e.target.value }))}
                  />
                </FormField>
              </div>
              <p className="text-xs text-gray-400 mt-1">e.g. 9:00 PM – 10:00 PM. Students who enter at 9:58 PM still get the full time limit.</p>
              {details.start_time && details.end_time && details.start_time === details.end_time && (
                <p className="text-xs text-red-500 mt-1">⚠️ &quot;Closes at&quot; cannot equal &quot;Opens at&quot;. Leave &quot;Closes at&quot; empty if you don&apos;t want a closing time. Overnight windows (e.g. 11 PM – 12 AM) are supported.</p>
              )}
            </div>

            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="toggle-shuffle-q" className="text-sm font-medium text-gray-700">Shuffle Questions</label>
                  <p className="text-xs text-gray-500 mt-0.5">Randomise question order for each student</p>
                </div>
                <Toggle id="toggle-shuffle-q" checked={details.shuffle_questions} onChange={(v) => setDetails((d) => ({ ...d, shuffle_questions: v }))} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="toggle-shuffle-o" className="text-sm font-medium text-gray-700">Shuffle Options</label>
                  <p className="text-xs text-gray-500 mt-0.5">Randomise MCQ option order for each student</p>
                </div>
                <Toggle id="toggle-shuffle-o" checked={details.shuffle_options} onChange={(v) => setDetails((d) => ({ ...d, shuffle_options: v }))} />
              </div>

              {/* Web attempt + camera proctoring toggles */}
              <div className="rounded-xl border border-gray-200 overflow-hidden">
                {/* Allow Web Attempt — always visible */}
                <div className="flex items-center justify-between p-4 bg-blue-50 border-b border-blue-100">
                  <div className="flex-1 pr-4">
                    <label htmlFor="toggle-web-attempt" className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      💻 Allow Web Attempt
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      When enabled, students can take this test from the Eduvo web portal. Off by default — tests are phone-only.
                    </p>
                  </div>
                  <Toggle
                    id="toggle-web-attempt"
                    checked={details.allow_web_attempt}
                    onChange={(v) => setDetails((d) => ({
                      ...d,
                      allow_web_attempt: v,
                      // Reset camera when web is turned off
                      require_camera: v ? d.require_camera : false,
                    }))}
                  />
                </div>

                {/* Require Camera — only visible when Allow Web Attempt is ON */}
                {details.allow_web_attempt && (
                  <div className="flex items-center justify-between p-4 pl-8 bg-white">
                    <div className="flex-1 pr-4">
                      <label htmlFor="toggle-camera" className="text-sm font-medium text-gray-700 flex items-center gap-2">
                        📷 Require Camera During Test
                      </label>
                      <p className="text-xs text-gray-500 mt-1">
                        Students must enable their webcam. Face detection will monitor for suspicious activity.
                      </p>
                    </div>
                    <Toggle
                      id="toggle-camera"
                      checked={details.require_camera}
                      onChange={(v) => setDetails((d) => ({ ...d, require_camera: v }))}
                    />
                  </div>
                )}
              </div>

              {/* ── Extra metadata ───────────────────────────────────────── */}
              <div className="border-t border-gray-100 pt-3 mt-1">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Curriculum &amp; Language</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <FormField label="Board" htmlFor="d-board">
                    <select id="d-board" className={inputClass} value={details.board}
                      onChange={(e) => setDetails((d) => ({ ...d, board: e.target.value }))}>
                      {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Chapter / Unit" htmlFor="d-chapter">
                    <input id="d-chapter" type="text" className={inputClass} placeholder="e.g. Chapter 3 (optional)"
                      value={details.chapter} onChange={(e) => setDetails((d) => ({ ...d, chapter: e.target.value }))} />
                  </FormField>
                  <FormField label="Question Language" htmlFor="d-language">
                    <select id="d-language" className={inputClass} value={details.language}
                      onChange={(e) => setDetails((d) => ({ ...d, language: e.target.value }))}>
                      {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </FormField>
                </div>
              </div>

              {/* ── Streak toggle ────────────────────────────────────────── */}
              <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                <div>
                  <label htmlFor="toggle-streak" className="text-sm font-medium text-gray-700">Counts toward student streak 🔥</label>
                  <p className="text-xs text-gray-500 mt-0.5">Students who submit this test will have their streak updated</p>
                </div>
                <Toggle id="toggle-streak" checked={details.contributes_to_streak}
                  onChange={(v) => setDetails((d) => ({ ...d, contributes_to_streak: v }))} />
              </div>
            </div>

            {/* ── AI Generate section ──────────────────────────────────── */}
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">✨</span>
                  <div>
                    <p className="text-sm font-semibold text-blue-900">Generate MCQ Questions with AI</p>
                    <p className="text-xs text-blue-700 mt-0.5">AI generates questions instantly — you can edit them in the next step</p>
                  </div>
                </div>
                <Toggle id="toggle-ai" checked={details.use_ai} onChange={(v) => setDetails((d) => ({ ...d, use_ai: v }))} />
              </div>

              {details.use_ai && (
                <div className="space-y-4 pt-1">

                  {/* Source mode toggle */}
                  <div className="flex gap-2">
                    <button type="button"
                      onClick={() => setAiSource('topic')}
                      className={`flex-1 py-2 text-xs font-semibold rounded-lg border-2 transition-colors ${aiSource === 'topic' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}>
                      📝 From Topic
                    </button>
                    <button type="button"
                      onClick={() => setAiSource('pdf')}
                      className={`flex-1 py-2 text-xs font-semibold rounded-lg border-2 transition-colors ${aiSource === 'pdf' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}>
                      📄 From PDF / Document
                    </button>
                  </div>

                  {/* ── Topic mode ── */}
                  {aiSource === 'topic' && (<>

                  {/* Topic source toggle: Manual vs Library */}
                  <div>
                    <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Topic Source</p>
                    <div className="flex gap-2">
                      <button type="button"
                        onClick={() => setTopicSourceMode('manual')}
                        className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg border-2 transition-colors ${
                          topicSourceMode === 'manual'
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                        }`}>
                        ✏️ Type Topic Manually
                      </button>
                      <button type="button"
                        onClick={() => {
                          setTopicSourceMode('library');
                          // Pre-populate library board from current details.board if it's CBSE or GSEB
                          const validBoards = ['CBSE', 'GSEB'];
                          const preBoard = validBoards.includes(details.board) ? details.board : 'CBSE';
                          setLibSelection((s) => ({ ...s, board: preBoard }));
                          if (details.class_name) {
                            fetchLibSubjects(preBoard, details.class_name);
                          }
                        }}
                        className={`flex-1 py-2 px-3 text-xs font-semibold rounded-lg border-2 transition-colors ${
                          topicSourceMode === 'library'
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
                        }`}>
                        📚 Choose from Library
                      </button>
                    </div>
                  </div>

                  {/* Manual topic mode — unchanged */}
                  {topicSourceMode === 'manual' && (
                  <FormField label="Topic" htmlFor="d-ai-topic" required>
                    <input id="d-ai-topic" type="text" className={inputClass}
                      placeholder="e.g. Laws of Motion, Photosynthesis, Linear Equations…"
                      value={details.ai_topic}
                      onChange={(e) => setDetails((d) => ({ ...d, ai_topic: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAIGenerate(); } }}
                    />
                  </FormField>
                  )}

                  {/* Library mode — cascading dropdowns + topic checkboxes */}
                  {topicSourceMode === 'library' && (
                  <div className="space-y-3 p-4 bg-indigo-50/60 border border-indigo-100 rounded-xl">

                    {/* Board dropdown */}
                    <FormField label="Board" htmlFor="lib-board">
                      <select id="lib-board" className={inputClass}
                        value={libSelection.board}
                        onChange={(e) => {
                          const b = e.target.value;
                          setLibSelection({ board: b, subject: '', chapterId: '', chapterNumber: 0, chapterName: '', allTopics: [], checkedTopics: new Set(), customTopicChecked: false, customTopicText: '' });
                          setLibChapters([]);
                          if (details.class_name) fetchLibSubjects(b, details.class_name);
                        }}>
                        <option value="CBSE">CBSE</option>
                        <option value="GSEB">GSEB</option>
                      </select>
                    </FormField>

                    {/* Subject — auto-matched from teacher's assigned subject, or manual picker */}
                    {(() => {
                      const matched = details.subject ? fuzzyMatchSubject(details.subject, libSubjects) : null;
                      if (matched) {
                        // Exact or fuzzy match found — show locked display, no dropdown needed
                        return (
                          <div className="flex items-center gap-2 px-3 py-2 bg-indigo-100/60 border border-indigo-200 rounded-lg">
                            <span className="text-xs text-indigo-600">📚 Subject:</span>
                            <span className="text-sm font-semibold text-indigo-800">{matched}</span>
                            {matched.toLowerCase() !== details.subject.toLowerCase() && (
                              <span className="text-xs text-indigo-400 ml-auto">matched from &quot;{details.subject}&quot;</span>
                            )}
                          </div>
                        );
                      }
                      // No match — show manual picker with all library subjects
                      return (
                        <FormField label="Subject" htmlFor="lib-subject">
                          <div className="relative">
                            <select id="lib-subject" className={inputClass}
                              disabled={libSubjectsLoading || libSubjects.length === 0}
                              value={libSelection.subject}
                              onChange={(e) => {
                                const s = e.target.value;
                                setLibSelection((prev) => ({ ...prev, subject: s, chapterId: '', chapterNumber: 0, chapterName: '', allTopics: [], checkedTopics: new Set(), customTopicChecked: false, customTopicText: '' }));
                                setLibChapters([]);
                                if (s && details.class_name) fetchLibChapters(libSelection.board, details.class_name, s);
                              }}>
                              <option value="">{libSubjectsLoading ? 'Loading…' : 'Select subject…'}</option>
                              {libSubjects.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                            {libSubjectsLoading && (
                              <div className="absolute right-9 top-1/2 -translate-y-1/2">
                                <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                              </div>
                            )}
                          </div>
                          {details.subject && !libSubjectsLoading && libSubjects.length > 0 && (
                            <p className="text-xs text-amber-600 mt-1">
                              ⚠️ &quot;{details.subject}&quot; wasn&apos;t found in the library for this board/class. Please pick the closest match.
                            </p>
                          )}
                        </FormField>
                      );
                    })()}

                    {/* Chapter dropdown */}
                    <FormField label="Chapter" htmlFor="lib-chapter">
                      <div className="relative">
                        <select id="lib-chapter" className={inputClass}
                          disabled={libChaptersLoading || libChapters.length === 0 || !libSelection.subject}
                          value={libSelection.chapterId}
                          onChange={(e) => {
                            const chId = e.target.value;
                            const ch = libChapters.find((c) => c.id === chId);
                            if (!ch) {
                              setLibSelection((prev) => ({ ...prev, chapterId: '', chapterNumber: 0, chapterName: '', allTopics: [], checkedTopics: new Set() }));
                              return;
                            }
                            const topicList = ch.topics
                              ? ch.topics.split(',').map((t) => t.trim()).filter(Boolean)
                              : [];
                            setLibSelection((prev) => ({
                              ...prev,
                              chapterId: chId,
                              chapterNumber: ch.chapter_number,
                              chapterName: ch.chapter_name,
                              allTopics: topicList,
                              checkedTopics: new Set(topicList), // all checked by default
                              customTopicChecked: false,
                              customTopicText: '',
                            }));
                          }}>
                          <option value="">{libChaptersLoading ? 'Loading…' : 'Select chapter…'}</option>
                          {libChapters.map((ch) => (
                            <option key={ch.id} value={ch.id}>
                              Ch. {ch.chapter_number} — {ch.chapter_name}
                            </option>
                          ))}
                        </select>
                        {libChaptersLoading && (
                          <div className="absolute right-9 top-1/2 -translate-y-1/2">
                            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                      </div>
                    </FormField>

                    {/* Topic checkboxes — shown after chapter is selected */}
                    {libSelection.chapterId && libSelection.allTopics.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-gray-700">
                          Select topics to include
                          <span className="font-normal text-gray-400 ml-1">(uncheck to exclude)</span>
                        </p>
                        <div className="space-y-1.5 bg-white border border-indigo-100 rounded-lg p-3 max-h-48 overflow-y-auto">
                          {libSelection.allTopics.map((topic) => (
                            <label key={topic} className="flex items-center gap-2.5 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={libSelection.checkedTopics.has(topic)}
                                onChange={(e) => {
                                  const next = new Set(libSelection.checkedTopics);
                                  if (e.target.checked) next.add(topic);
                                  else next.delete(topic);
                                  setLibSelection((prev) => ({ ...prev, checkedTopics: next }));
                                }}
                                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 shrink-0"
                              />
                              <span className="text-sm text-gray-700 group-hover:text-gray-900">{topic}</span>
                            </label>
                          ))}

                          {/* "Other" custom topic option */}
                          <div className="border-t border-gray-100 pt-2 mt-1">
                            <label className="flex items-center gap-2.5 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={libSelection.customTopicChecked}
                                onChange={(e) => setLibSelection((prev) => ({
                                  ...prev,
                                  customTopicChecked: e.target.checked,
                                  customTopicText: e.target.checked ? prev.customTopicText : '',
                                }))}
                                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 shrink-0"
                              />
                              <span className="text-sm text-gray-500 italic">Other — type your own topic</span>
                            </label>
                            {libSelection.customTopicChecked && (
                              <input
                                type="text"
                                className={`${inputClass} mt-2 ml-6`}
                                placeholder="Enter custom topic…"
                                value={libSelection.customTopicText}
                                onChange={(e) => setLibSelection((prev) => ({ ...prev, customTopicText: e.target.value }))}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Summary box */}
                    {libSelection.chapterId && (
                      <div className="bg-indigo-600/5 border border-indigo-200 rounded-xl p-3.5 text-xs text-indigo-900 space-y-0.5">
                        <p className="font-semibold text-indigo-700 mb-1.5">📋 Generating test for:</p>
                        <p><span className="font-medium">{libSelection.board}</span> · Class {details.class_name} · <span className="font-medium">{libSelection.subject}</span></p>
                        <p>Chapter {libSelection.chapterNumber}: <span className="font-medium">{libSelection.chapterName}</span></p>
                        {(() => {
                          const finalTopics = getLibraryFinalTopics();
                          return finalTopics ? (
                            <p className="text-indigo-600 mt-0.5">Topics: {finalTopics}</p>
                          ) : (
                            <p className="text-gray-400 italic">No topics selected — all chapter topics will be used</p>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-gray-700">Number of questions</p>
                    <div className="flex flex-wrap gap-2">
                      {[5, 8, 10, 15, 20, 25, 30].map((n) => (
                        <button key={n} type="button"
                          onClick={() => setDetails((d) => ({ ...d, ai_count: n }))}
                          className={`w-11 h-9 rounded-lg text-sm font-semibold border transition-colors ${
                            details.ai_count === n ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                          }`}>{n}</button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-gray-700">Difficulty</p>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {(['mixed','easy','medium','hard','custom'] as const).map((d) => (
                        <button key={d} type="button"
                          onClick={() => setDetails((prev) => ({ ...prev, ai_difficulty: d }))}
                          className={`py-1.5 text-xs font-semibold rounded-lg border transition-colors capitalize ${
                            details.ai_difficulty === d ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                          }`}>{d}</button>
                      ))}
                    </div>

                    {details.ai_difficulty === 'custom' && (
                      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                        <p className="text-xs text-gray-500">Total must equal {details.ai_count} questions</p>
                        {([
                          { label: '🟢 Easy', key: 'ai_easy_count' as const, color: 'text-green-700' },
                          { label: '🟡 Medium', key: 'ai_medium_count' as const, color: 'text-yellow-700' },
                          { label: '🔴 Hard', key: 'ai_hard_count' as const, color: 'text-red-700' },
                        ]).map(({ label, key, color }) => (
                          <div key={key} className="flex items-center gap-3">
                            <span className={`text-xs font-semibold w-20 shrink-0 ${color}`}>{label}</span>
                            <input type="range" min={0} max={details.ai_count} value={details[key]}
                              onChange={(e) => setDetails((d) => ({ ...d, [key]: parseInt(e.target.value) }))}
                              className="flex-1 accent-blue-600" />
                            <span className="text-sm font-bold text-gray-800 w-6 text-right">{details[key]}</span>
                          </div>
                        ))}
                        <div className={`text-xs font-medium ${
                          details.ai_easy_count + details.ai_medium_count + details.ai_hard_count === details.ai_count
                            ? 'text-green-600' : 'text-red-500'
                        }`}>
                          Total: {details.ai_easy_count + details.ai_medium_count + details.ai_hard_count} / {details.ai_count}
                        </div>
                      </div>
                    )}
                  </div>

                  {generateError && (
                    <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{generateError}</div>
                  )}

                  <button type="button" onClick={handleAIGenerate}
                    disabled={generating || !details.class_name || !details.subject || (topicSourceMode === 'manual' && !details.ai_topic.trim()) || (topicSourceMode === 'library' && !libSelection.chapterId)}
                    className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-lg transition-colors">
                    {generating ? (
                      <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating…</>
                    ) : (
                      <>✨ Generate {details.ai_count} Questions &amp; Continue</>
                    )}
                  </button>
                  </>)}

                  {/* ── PDF mode ── */}
                  {aiSource === 'pdf' && (<>
                    <p className="text-xs text-blue-700">Upload a PDF, Word doc, or text file. AI will generate MCQ questions from its content.</p>

                    {/* Drop zone */}
                    {pdfUploadState !== 'done' ? (
                      <div
                        onClick={() => pdfInputRef.current?.click()}
                        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handlePdfUpload(f); }}
                        onDragOver={(e) => e.preventDefault()}
                        className="border-2 border-dashed border-blue-300 rounded-xl p-5 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50/30 transition-colors"
                      >
                        <input ref={pdfInputRef} type="file" accept=".pdf,.docx,.txt" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfUpload(f); }} />
                        {pdfUploadState === 'uploading' ? (
                          <div className="flex items-center justify-center gap-2 text-sm text-blue-600">
                            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                            Extracting text…
                          </div>
                        ) : (
                          <>
                            <div className="text-2xl mb-1">📄</div>
                            <p className="text-sm font-medium text-gray-700">Drop file here or click to browse</p>
                            <p className="text-xs text-gray-400 mt-0.5">.pdf, .docx, .txt · max 5 MB</p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-between px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-green-600 shrink-0">✓</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-green-800 truncate">{pdfFile?.name}</p>
                            <p className="text-xs text-green-600">{pdfTotalChars.toLocaleString()} characters extracted</p>
                          </div>
                        </div>
                        <button type="button" onClick={() => { setPdfUploadState('idle'); setPdfFile(null); setPdfExtractionId(''); setPdfUploadError(''); }}
                          className="text-xs text-green-500 hover:text-green-700 ml-2">Change</button>
                      </div>
                    )}

                    {pdfUploadError && (
                      <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{pdfUploadError}</p>
                    )}

                    {/* Question count */}
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-gray-700">Number of questions</p>
                      <div className="flex flex-wrap gap-2">
                        {[5, 8, 10, 15, 20].map((n) => (
                          <button key={n} type="button"
                            onClick={() => setDetails((d) => ({ ...d, ai_count: n }))}
                            className={`w-11 h-9 rounded-lg text-sm font-semibold border transition-colors ${
                              details.ai_count === n ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                            }`}>{n}</button>
                        ))}
                      </div>
                    </div>

                    {generateError && (
                      <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{generateError}</div>
                    )}

                    <button type="button" onClick={handleAIGenerateFromPdf}
                      disabled={generating || pdfUploadState !== 'done' || !details.class_name || !details.subject}
                      className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-semibold rounded-lg transition-colors">
                      {generating ? (
                        <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />{pdfGenerateStage || 'Generating…'}</>
                      ) : (
                        <>✨ Generate {details.ai_count} Questions from PDF &amp; Continue</>
                      )}
                    </button>
                  </>)}

                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleNextFromStep1}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Next: Add Questions
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Add Questions ────────────────────────────────────────── */}
      {step === 2 && (
        <div className="max-w-2xl space-y-5">
          {/* Running total */}
          <div className="flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center gap-4 text-sm">
              <span className="font-semibold text-gray-900">
                {questions.length} question{questions.length !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-400">·</span>
              <span className="font-semibold text-blue-600">{totalMarks} total marks</span>
              {mcqCount > 0 && <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{mcqCount} MCQ</span>}
              {theoryCount > 0 && <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">{theoryCount} Theory</span>}
            </div>
          </div>

          {questionsError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {questionsError}
            </div>
          )}

          {/* Add question buttons — show when no form is open */}
          {activeForm === null && (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setMcqDraft({ ...EMPTY_MCQ }); setEditingIndex(null); setQuestionError(''); setActiveForm('mcq'); }}
                className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add MCQ Question
              </button>
              <button
                type="button"
                onClick={() => { setTheoryDraft({ ...EMPTY_THEORY }); setEditingIndex(null); setQuestionError(''); setActiveForm('theory'); }}
                className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Theory Question
              </button>
            </div>
          )}

          {/* Active question form */}
          {activeForm === 'mcq' && (
            <MCQForm
              draft={mcqDraft}
              onChange={setMcqDraft}
              onSave={validateAndSaveMCQ}
              onCancel={handleCancelForm}
              error={questionError}
            />
          )}
          {activeForm === 'theory' && (
            <TheoryForm
              draft={theoryDraft}
              onChange={setTheoryDraft}
              onSave={validateAndSaveTheory}
              onCancel={handleCancelForm}
              error={questionError}
            />
          )}

          {/* Saved questions list */}
          {questions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Saved Questions</p>
              {questions.map((q, idx) => (
                <QuestionRow
                  key={idx}
                  q={q}
                  index={idx}
                  onEdit={() => handleEditQuestion(idx)}
                  onDelete={() => handleDeleteQuestion(idx)}
                />
              ))}
            </div>
          )}

          {questions.length === 0 && activeForm === null && (
            <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl">
              <p className="text-sm text-gray-400">No questions yet. Add your first question above.</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => { setStep(1); setQuestionsError(''); }}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <button
              type="button"
              onClick={handleNextFromStep2}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Next: Review & Publish
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Review & Publish ─────────────────────────────────────── */}
      {step === 3 && (
        <div className="max-w-2xl space-y-5">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">{details.title}</h2>
              <div className="flex flex-wrap gap-2 mt-3">
                {[
                  { label: 'Class', value: `${details.class_name} · ${details.section}` },
                  { label: 'Subject', value: details.subject },
                  { label: 'Test Type', value: EXAM_TYPE_LABELS[details.exam_type] ?? details.exam_type },
                  { label: 'Term', value: TERM_LABELS[details.term] ?? details.term },
                  { label: 'Date', value: new Date(details.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) },
                  ...(details.time_limit_minutes ? [{ label: 'Time Limit', value: `${details.time_limit_minutes} min` }] : []),
                ].map((item) => (
                  <span key={item.label} className="text-xs px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full">
                    <span className="font-medium">{item.label}:</span> {item.value}
                  </span>
                ))}
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 divide-x divide-gray-100 border-b border-gray-100">
              {[
                { label: 'Total Marks', value: totalMarks, color: 'text-blue-600' },
                { label: 'MCQ Questions', value: mcqCount, color: 'text-blue-500' },
                { label: 'Theory Questions', value: theoryCount, color: 'text-purple-600' },
              ].map((stat) => (
                <div key={stat.label} className="px-6 py-4 text-center">
                  <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
                </div>
              ))}
            </div>

            {/* Settings summary */}
            <div className="px-6 py-3 border-b border-gray-100 flex gap-4 text-xs text-gray-500">
              <span className={`flex items-center gap-1 ${details.shuffle_questions ? 'text-green-600' : 'text-gray-400'}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {details.shuffle_questions
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />}
                </svg>
                Shuffle Questions
              </span>
              <span className={`flex items-center gap-1 ${details.shuffle_options ? 'text-green-600' : 'text-gray-400'}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {details.shuffle_options
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />}
                </svg>
                Shuffle Options
              </span>
            </div>

            {/* Questions preview */}
            <div className="divide-y divide-gray-50">
              {questions.map((q, idx) => (
                <div key={idx} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-medium text-gray-900">
                      <span className="text-gray-400 mr-2">Q{idx + 1}.</span>{q.text}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <QTypeBadge type={q.type} />
                      <span className="text-xs text-gray-500 font-medium">{q.marks}m</span>
                    </div>
                  </div>
                  {q.type === 'mcq' && (
                    <div className="grid grid-cols-2 gap-1.5 mt-2 ml-5">
                      {(q as MCQDraft).options.map((opt, oi) => (
                        <div key={oi} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                          (q as MCQDraft).correct_option === oi
                            ? 'bg-green-50 border border-green-200 text-green-700 font-medium'
                            : 'bg-gray-50 text-gray-600'
                        }`}>
                          <span className="font-bold">{String.fromCharCode(65 + oi)}.</span>
                          {opt}
                          {(q as MCQDraft).correct_option === oi && (
                            <svg className="w-3 h-3 ml-auto shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {publishError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {publishError}
            </div>
          )}

          {/* ── Restrict Test Access ─────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Restrict Test Access</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Block specific students from taking this test. They will see a lock icon with a &quot;Pay your fees to unlock&quot; message.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={blockRestrictions}
                  onClick={() => setBlockRestrictions((v) => !v)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                    blockRestrictions ? 'bg-red-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    blockRestrictions ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>
            </div>

            {blockRestrictions && (
              <div className="px-6 py-4">
                {loadingStudents ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    Loading students…
                  </div>
                ) : classStudents.length === 0 ? (
                  <p className="text-sm text-gray-400 py-2">No students found in this class/section.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs text-gray-500">
                        Select students to block. Blocked students see a 🔒 lock icon on this test.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setBlockedStudentIds(new Set(classStudents.map((s) => s.id)))}
                          className="text-xs text-red-600 hover:text-red-700 font-medium"
                        >
                          Block all
                        </button>
                        <span className="text-gray-300">·</span>
                        <button
                          type="button"
                          onClick={() => setBlockedStudentIds(new Set())}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Clear all
                        </button>
                      </div>
                    </div>

                    {blockedStudentIds.size > 0 && (
                      <div className="mb-3 px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700">
                        🔒 {blockedStudentIds.size} student{blockedStudentIds.size !== 1 ? 's' : ''} will be blocked from this test
                      </div>
                    )}

                    <div className="max-h-64 overflow-y-auto space-y-1.5 border border-gray-100 rounded-lg p-2">
                      {classStudents.map((student) => {
                        const blocked = blockedStudentIds.has(student.id);
                        return (
                          <label
                            key={student.id}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                              blocked ? 'bg-red-50 border border-red-100' : 'hover:bg-gray-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={blocked}
                              onChange={(e) => {
                                const next = new Set(blockedStudentIds);
                                if (e.target.checked) next.add(student.id);
                                else next.delete(student.id);
                                setBlockedStudentIds(next);
                              }}
                              className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-gray-800">{student.full_name}</span>
                              {student.roll_number && (
                                <span className="text-xs text-gray-400 ml-2">#{student.roll_number}</span>
                              )}
                            </div>
                            {blocked && <span className="text-xs text-red-500 font-medium">🔒 Blocked</span>}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => { setStep(2); setPublishError(''); }}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Questions
            </button>
            <button
              type="button"
              onClick={handlePublish}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Publish Test
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
