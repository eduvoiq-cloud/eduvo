'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface WebIntegrityResult {
  tab_exit_count: number;
  total_exit_duration_seconds: number;
  longest_exit_seconds: number;
  fullscreen_exit_count: number;
  face_absent_count: number;
  face_absent_duration_seconds: number;
  multiple_faces_count: number;
}

export interface UseWebIntegrityReturn {
  startTracking: () => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  finaliseTracking: () => WebIntegrityResult;
  isTimerPaused: boolean;
  /** Notified when a fullscreen exit occurs — show the red overlay */
  isFullscreenExited: boolean;
  reenterFullscreen: () => void;
  recordFaceAbsent: () => void;
  recordFacePresent: () => void;
  recordMultipleFaces: () => void;
}

export function useWebIntegrity(): UseWebIntegrityReturn {
  // ── Tab / visibility tracking ─────────────────────────────────────────────
  const tabExitCountRef       = useRef(0);
  const totalExitMsRef        = useRef(0);
  const longestExitMsRef      = useRef(0);
  const exitStartRef          = useRef<number | null>(null);
  const isOutsideRef          = useRef(false);
  const trackingRef           = useRef(false);

  // ── Fullscreen tracking ───────────────────────────────────────────────────
  const fullscreenExitCountRef = useRef(0);
  const [isFullscreenExited, setIsFullscreenExited] = useState(false);

  // ── Timer pause (while fullscreen exited) ─────────────────────────────────
  const [isTimerPaused, setIsTimerPaused] = useState(false);

  // ── Camera / face tracking ────────────────────────────────────────────────
  const faceAbsentCountRef        = useRef(0);
  const faceAbsentDurationMsRef   = useRef(0);
  const faceAbsentStartRef        = useRef<number | null>(null);
  const isFaceAbsentRef           = useRef(false);
  const multipleFacesCountRef     = useRef(0);

  // ── Tab exit handlers ─────────────────────────────────────────────────────
  const recordTabExit = useCallback(() => {
    if (!trackingRef.current || isOutsideRef.current) return;
    isOutsideRef.current = true;
    exitStartRef.current = Date.now();
    tabExitCountRef.current += 1;
  }, []);

  const recordTabReturn = useCallback(() => {
    if (!trackingRef.current || !isOutsideRef.current) return;
    const start = exitStartRef.current;
    if (start !== null) {
      const duration = Date.now() - start;
      totalExitMsRef.current += duration;
      if (duration > longestExitMsRef.current) longestExitMsRef.current = duration;
    }
    isOutsideRef.current = false;
    exitStartRef.current = null;
  }, []);

  // ── Face detection callbacks (called by the camera hook) ──────────────────
  const recordFaceAbsent = useCallback(() => {
    if (!trackingRef.current || isFaceAbsentRef.current) return;
    isFaceAbsentRef.current = true;
    faceAbsentStartRef.current = Date.now();
    faceAbsentCountRef.current += 1;
  }, []);

  const recordFacePresent = useCallback(() => {
    if (!isFaceAbsentRef.current) return;
    const start = faceAbsentStartRef.current;
    if (start !== null) {
      faceAbsentDurationMsRef.current += Date.now() - start;
    }
    isFaceAbsentRef.current = false;
    faceAbsentStartRef.current = null;
  }, []);

  const recordMultipleFaces = useCallback(() => {
    if (!trackingRef.current) return;
    multipleFacesCountRef.current += 1;
  }, []);

  // ── Fullscreen handlers ───────────────────────────────────────────────────
  const handleFullscreenChange = useCallback(() => {
    if (!trackingRef.current) return;
    const isInFullscreen =
      !!document.fullscreenElement ||
      !!(document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;

    if (!isInFullscreen) {
      fullscreenExitCountRef.current += 1;
      setIsFullscreenExited(true);
      setIsTimerPaused(true);
    }
  }, []);

  const reenterFullscreen = useCallback(() => {
    const el = document.documentElement;
    const req = el.requestFullscreen?.bind(el)
      ?? (el as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
    if (req) {
      req().then(() => {
        setIsFullscreenExited(false);
        setIsTimerPaused(false);
      }).catch(() => {/* user denied — leave overlay */});
    }
  }, []);

  // ── Keyboard / right-click restrictions ──────────────────────────────────
  const blockContextMenu = useCallback((e: MouseEvent) => {
    if (!trackingRef.current) return;
    e.preventDefault();
  }, []);

  const blockKeys = useCallback((e: KeyboardEvent) => {
    if (!trackingRef.current) return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (
      (ctrl && (key === 'c' || key === 'v' || key === 'u')) ||
      key === 'f12' ||
      (ctrl && e.shiftKey && key === 'i')
    ) {
      e.preventDefault();
    }
  }, []);

  // ── Page leave warning ────────────────────────────────────────────────────
  const handleBeforeUnload = useCallback((e: BeforeUnloadEvent) => {
    if (!trackingRef.current) return;
    e.preventDefault();
    e.returnValue = 'You have an active test. Leaving will lose your progress.';
  }, []);

  // ── Start / Stop ──────────────────────────────────────────────────────────
  const startTracking = useCallback(() => {
    trackingRef.current = true;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) recordTabExit();
      else recordTabReturn();
    });
    window.addEventListener('blur', recordTabExit);
    window.addEventListener('focus', recordTabReturn);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('contextmenu', blockContextMenu);
    document.addEventListener('keydown', blockKeys);
    window.addEventListener('beforeunload', handleBeforeUnload);
  }, [recordTabExit, recordTabReturn, handleFullscreenChange, blockContextMenu, blockKeys, handleBeforeUnload]);

  const stopTracking = useCallback(() => {
    trackingRef.current = false;
    document.removeEventListener('visibilitychange', recordTabReturn);
    window.removeEventListener('blur', recordTabExit);
    window.removeEventListener('focus', recordTabReturn);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.removeEventListener('contextmenu', blockContextMenu);
    document.removeEventListener('keydown', blockKeys);
    window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recordTabExit, recordTabReturn, handleFullscreenChange, blockContextMenu, blockKeys, handleBeforeUnload]);

  const pauseTimer = useCallback(() => setIsTimerPaused(true), []);
  const resumeTimer = useCallback(() => setIsTimerPaused(false), []);

  const finaliseTracking = useCallback((): WebIntegrityResult => {
    // Flush any open tab exit
    if (isOutsideRef.current && exitStartRef.current !== null) {
      const duration = Date.now() - exitStartRef.current;
      totalExitMsRef.current += duration;
      if (duration > longestExitMsRef.current) longestExitMsRef.current = duration;
    }
    // Flush any open face-absent span
    if (isFaceAbsentRef.current && faceAbsentStartRef.current !== null) {
      faceAbsentDurationMsRef.current += Date.now() - faceAbsentStartRef.current;
    }
    stopTracking();
    return {
      tab_exit_count: tabExitCountRef.current,
      total_exit_duration_seconds: Math.round(totalExitMsRef.current / 1000),
      longest_exit_seconds: Math.round(longestExitMsRef.current / 1000),
      fullscreen_exit_count: fullscreenExitCountRef.current,
      face_absent_count: faceAbsentCountRef.current,
      face_absent_duration_seconds: Math.round(faceAbsentDurationMsRef.current / 1000),
      multiple_faces_count: multipleFacesCountRef.current,
    };
  }, [stopTracking]);

  // Clean up on unmount
  useEffect(() => () => { stopTracking(); }, [stopTracking]);

  return {
    startTracking,
    pauseTimer,
    resumeTimer,
    finaliseTracking,
    isTimerPaused,
    isFullscreenExited,
    reenterFullscreen,
    recordFaceAbsent,
    recordFacePresent,
    recordMultipleFaces,
  };
}
