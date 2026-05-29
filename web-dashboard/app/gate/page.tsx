'use client';

/**
 * RFID Gate Attendance Screen
 *
 * Runs on a school computer with a USB RFID reader (acts as keyboard).
 * No login required. Opened once by school admin and left running all day.
 *
 * Architecture: This page → Express backend (/api/attendance/rfid) → Supabase.
 * Never calls Supabase directly.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const DISPLAY_DURATION_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const PENDING_SCANS_KEY = 'pending_scans';
const SCHOOL_ID_KEY = 'gate_school_id';
const SCHOOL_NAME_KEY = 'gate_school_name';

// ── Types ─────────────────────────────────────────────────────────────────────

type ScreenState = 'ready' | 'success' | 'duplicate' | 'error' | 'offline';

interface PendingScan {
  rfid_uid: string;
  timestamp: string;
  school_id: string;
}

interface RfidResponse {
  success: boolean;
  error?: string;
  student_name?: string;
  class?: string;
  section?: string;
  marked_at?: string;
}

interface SchoolOption {
  id: string;
  name: string;
}

// ── Web Audio beep helpers ────────────────────────────────────────────────────

function playBeep(frequency: number, duration: number, type: OscillatorType = 'sine'): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration / 1000);
    osc.onended = () => ctx.close();
  } catch {
    // AudioContext not available (SSR or restricted context) — silently skip
  }
}

const beepSuccess = () => playBeep(880, 200, 'sine');
const beepDuplicate = () => playBeep(440, 300, 'sine');
const beepError = () => playBeep(220, 500, 'sine');

// ── Clock component ───────────────────────────────────────────────────────────

const LiveClock = React.memo(function LiveClock() {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      setTime(`${hh}:${mm}:${ss}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return <span>{time}</span>;
});

// ── School Setup Modal ────────────────────────────────────────────────────────

interface SetupModalProps {
  onConfirm: (schoolId: string, schoolName: string) => void;
}

const SetupModal = React.memo(function SetupModal({ onConfirm }: SetupModalProps) {
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${BASE_URL}/api/schools/list`)
      .then((r) => r.json())
      .then((json) => {
        const list: SchoolOption[] = Array.isArray(json.data) ? json.data : [];
        setSchools(list);
        if (list.length > 0) setSelected(list[0].id);
      })
      .catch(() => setError('Could not load schools. Check your connection.'))
      .finally(() => setLoading(false));
  }, []);

  const handleConfirm = () => {
    const school = schools.find((s) => s.id === selected);
    if (!school) return;
    onConfirm(school.id, school.name);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: '40px 48px',
          width: 420,
          maxWidth: '90vw',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: '#111' }}>
          Gate Setup
        </h2>
        <p style={{ margin: '0 0 24px', color: '#555', fontSize: 14 }}>
          Select the school for this gate terminal.
        </p>

        {loading && <p style={{ color: '#888' }}>Loading schools…</p>}
        {error && <p style={{ color: '#ef4444' }}>{error}</p>}

        {!loading && !error && (
          <>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 16,
                border: '1px solid #d1d5db',
                borderRadius: 8,
                marginBottom: 20,
                outline: 'none',
              }}
            >
              {schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <button
              onClick={handleConfirm}
              disabled={!selected}
              style={{
                width: '100%',
                padding: '12px',
                background: selected ? '#2563eb' : '#93c5fd',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 16,
                fontWeight: 600,
                cursor: selected ? 'pointer' : 'not-allowed',
              }}
            >
              Confirm
            </button>
          </>
        )}
      </div>
    </div>
  );
});

// ── Main Gate Page ────────────────────────────────────────────────────────────

export default function GatePage() {
  // Setup state
  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [schoolName, setSchoolName] = useState('');
  const [setupReady, setSetupReady] = useState(false);

  // Screen state
  const [screen, setScreen] = useState<ScreenState>('ready');
  const [studentName, setStudentName] = useState('');
  const [classSection, setClassSection] = useState('');
  const [markedAt, setMarkedAt] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [todayCount, setTodayCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Hidden input ref
  const inputRef = useRef<HTMLInputElement>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingRef = useRef(false);

  // ── Load school from localStorage on mount ──────────────────────────────────
  useEffect(() => {
    const id = localStorage.getItem(SCHOOL_ID_KEY);
    const name = localStorage.getItem(SCHOOL_NAME_KEY) ?? '';
    if (id) {
      setSchoolId(id);
      setSchoolName(name);
    }
    setSetupReady(true);

    // Load pending count
    const pending: PendingScan[] = JSON.parse(localStorage.getItem(PENDING_SCANS_KEY) ?? '[]');
    setPendingCount(pending.length);
  }, []);

  // ── Focus management ────────────────────────────────────────────────────────
  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!setupReady || !schoolId) return;
    focusInput();

    const handleVisibilityChange = () => {
      if (!document.hidden) focusInput();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [setupReady, schoolId, focusInput]);

  // ── Reset to ready state ────────────────────────────────────────────────────
  const resetToReady = useCallback(() => {
    setScreen('ready');
    setStudentName('');
    setClassSection('');
    setMarkedAt('');
    setErrorMsg('');
    focusInput();
  }, [focusInput]);

  const scheduleReset = useCallback(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(resetToReady, DISPLAY_DURATION_MS);
  }, [resetToReady]);

  // ── Offline: store pending scan ─────────────────────────────────────────────
  const storePendingScan = useCallback((rfid_uid: string, sid: string) => {
    const existing: PendingScan[] = JSON.parse(localStorage.getItem(PENDING_SCANS_KEY) ?? '[]');
    existing.push({ rfid_uid, timestamp: new Date().toISOString(), school_id: sid });
    localStorage.setItem(PENDING_SCANS_KEY, JSON.stringify(existing));
    setPendingCount(existing.length);
  }, []);

  // ── Sync pending scans ──────────────────────────────────────────────────────
  const syncPending = useCallback(async () => {
    const pending: PendingScan[] = JSON.parse(localStorage.getItem(PENDING_SCANS_KEY) ?? '[]');
    if (pending.length === 0) return;

    setSyncing(true);
    const failed: PendingScan[] = [];

    for (const scan of pending) {
      try {
        const res = await fetch(`${BASE_URL}/api/attendance/rfid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rfid_uid: scan.rfid_uid, school_id: scan.school_id }),
        });
        if (!res.ok) failed.push(scan);
        else setTodayCount((c) => c + 1);
      } catch {
        failed.push(scan);
      }
    }

    localStorage.setItem(PENDING_SCANS_KEY, JSON.stringify(failed));
    setPendingCount(failed.length);
    setSyncing(false);
  }, []);

  // ── Health check loop ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!setupReady || !schoolId) return;

    const check = async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`, { method: 'GET' });
        if (res.ok) {
          const pending: PendingScan[] = JSON.parse(localStorage.getItem(PENDING_SCANS_KEY) ?? '[]');
          if (pending.length > 0) await syncPending();
        }
      } catch {
        // Still offline — do nothing
      }
    };

    const id = setInterval(check, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [setupReady, schoolId, syncPending]);

  // ── RFID scan handler ───────────────────────────────────────────────────────
  const handleScan = useCallback(
    async (rfid_uid: string) => {
      if (!schoolId || processingRef.current) return;
      processingRef.current = true;

      try {
        const res = await fetch(`${BASE_URL}/api/attendance/rfid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rfid_uid, school_id: schoolId }),
        });

        const json: RfidResponse = await res.json();

        if (json.success) {
          // SUCCESS
          setStudentName(json.student_name ?? '');
          setClassSection(
            [json.class, json.section].filter(Boolean).join(' — ')
          );
          setScreen('success');
          setTodayCount((c) => c + 1);
          beepSuccess();
          scheduleReset();
        } else if (json.error === 'Already marked') {
          // DUPLICATE
          setStudentName(json.student_name ?? '');
          setMarkedAt(json.marked_at ?? '');
          setScreen('duplicate');
          beepDuplicate();
          scheduleReset();
        } else {
          // ERROR (card not registered, etc.)
          setErrorMsg(json.error ?? 'Unknown error');
          setScreen('error');
          beepError();
          scheduleReset();
        }
      } catch {
        // Network error → offline
        storePendingScan(rfid_uid, schoolId);
        setScreen('offline');
        beepError();
        scheduleReset();
      } finally {
        processingRef.current = false;
      }
    },
    [schoolId, scheduleReset, storePendingScan]
  );

  // ── Keydown listener on hidden input ───────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const uid = (e.currentTarget.value ?? '').trim();
        e.currentTarget.value = '';
        if (uid) void handleScan(uid);
      }
    },
    [handleScan]
  );

  // ── School setup confirm ────────────────────────────────────────────────────
  const handleSetupConfirm = useCallback((id: string, name: string) => {
    localStorage.setItem(SCHOOL_ID_KEY, id);
    localStorage.setItem(SCHOOL_NAME_KEY, name);
    setSchoolId(id);
    setSchoolName(name);
  }, []);

  const handleChangeSchool = useCallback(() => {
    localStorage.removeItem(SCHOOL_ID_KEY);
    localStorage.removeItem(SCHOOL_NAME_KEY);
    setSchoolId(null);
    setSchoolName('');
    setScreen('ready');
    setTodayCount(0);
  }, []);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const bgColor: Record<ScreenState, string> = {
    ready: '#ffffff',
    success: '#22c55e',
    duplicate: '#f97316',
    error: '#ef4444',
    offline: '#6b7280',
  };

  const isColored = screen !== 'ready';

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!setupReady) return null;

  return (
    <>
      {/* Setup modal — shown when no school configured */}
      {!schoolId && <SetupModal onConfirm={handleSetupConfirm} />}

      {/* Full-screen gate display */}
      <div
        onClick={focusInput}
        style={{
          position: 'fixed',
          inset: 0,
          background: bgColor[screen],
          display: 'flex',
          flexDirection: 'column',
          userSelect: 'none',
          cursor: 'default',
        }}
      >
        {/* Hidden RFID input — always focused */}
        <input
          ref={inputRef}
          onKeyDown={handleKeyDown}
          onBlur={focusInput}
          aria-hidden="true"
          autoComplete="off"
          style={{
            position: 'absolute',
            opacity: 0,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />

        {/* ── Top bar ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 28px',
            borderBottom: isColored ? 'none' : '1px solid #e5e7eb',
          }}
        >
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: isColored ? '#fff' : '#111',
            }}
          >
            {schoolName || 'Gate Terminal'}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <span
              style={{
                fontSize: 22,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: isColored ? '#fff' : '#374151',
              }}
            >
              <LiveClock />
            </span>

            {schoolId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleChangeSchool();
                }}
                style={{
                  fontSize: 12,
                  color: isColored ? 'rgba(255,255,255,0.7)' : '#9ca3af',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: 4,
                }}
              >
                Change School
              </button>
            )}
          </div>
        </div>

        {/* ── Center content ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 40px',
            textAlign: 'center',
          }}
        >
          {screen === 'ready' && (
            <span
              style={{
                fontSize: 'clamp(64px, 12vw, 120px)',
                fontWeight: 800,
                color: '#d1d5db',
                letterSpacing: '-2px',
              }}
            >
              TAP CARD
            </span>
          )}

          {screen === 'success' && (
            <>
              <span
                style={{
                  fontSize: 'clamp(48px, 9vw, 96px)',
                  fontWeight: 800,
                  color: '#fff',
                  lineHeight: 1.1,
                  marginBottom: 16,
                }}
              >
                {studentName}
              </span>
              {classSection && (
                <span
                  style={{
                    fontSize: 'clamp(28px, 5vw, 52px)',
                    fontWeight: 600,
                    color: '#fff',
                    marginBottom: 20,
                  }}
                >
                  {classSection}
                </span>
              )}
              <span
                style={{
                  fontSize: 'clamp(32px, 6vw, 64px)',
                  fontWeight: 700,
                  color: '#fff',
                }}
              >
                PRESENT ✓
              </span>
            </>
          )}

          {screen === 'duplicate' && (
            <>
              <span
                style={{
                  fontSize: 'clamp(40px, 8vw, 80px)',
                  fontWeight: 800,
                  color: '#fff',
                  marginBottom: 16,
                }}
              >
                ALREADY MARKED
              </span>
              <span
                style={{
                  fontSize: 'clamp(24px, 4vw, 44px)',
                  fontWeight: 600,
                  color: '#fff',
                  marginBottom: 8,
                }}
              >
                {studentName}
              </span>
              {markedAt && (
                <span
                  style={{
                    fontSize: 'clamp(20px, 3vw, 36px)',
                    color: 'rgba(255,255,255,0.85)',
                  }}
                >
                  Marked at {markedAt}
                </span>
              )}
            </>
          )}

          {screen === 'error' && (
            <span
              style={{
                fontSize: 'clamp(36px, 7vw, 72px)',
                fontWeight: 800,
                color: '#fff',
              }}
            >
              {errorMsg || 'ERROR'}
            </span>
          )}

          {screen === 'offline' && (
            <>
              <span
                style={{
                  fontSize: 'clamp(40px, 8vw, 80px)',
                  fontWeight: 800,
                  color: '#fff',
                  marginBottom: 16,
                }}
              >
                NO INTERNET
              </span>
              <span
                style={{
                  fontSize: 'clamp(20px, 3.5vw, 40px)',
                  color: 'rgba(255,255,255,0.9)',
                  marginBottom: 8,
                }}
              >
                Scan saved — will sync when connected
              </span>
              <span
                style={{
                  fontSize: 'clamp(18px, 3vw, 32px)',
                  color: 'rgba(255,255,255,0.75)',
                }}
              >
                {pendingCount} scan{pendingCount !== 1 ? 's' : ''} pending sync
              </span>
            </>
          )}
        </div>

        {/* ── Bottom bar ── */}
        <div
          style={{
            padding: '14px 28px',
            borderTop: isColored ? 'none' : '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: isColored ? '#fff' : '#374151',
            }}
          >
            Today: {todayCount} student{todayCount !== 1 ? 's' : ''} present
          </span>

          {pendingCount > 0 && screen !== 'offline' && (
            <span
              style={{
                fontSize: 14,
                color: isColored ? 'rgba(255,255,255,0.8)' : '#9ca3af',
              }}
            >
              {syncing ? `Syncing ${pendingCount} scan${pendingCount !== 1 ? 's' : ''}…` : `${pendingCount} pending sync`}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
