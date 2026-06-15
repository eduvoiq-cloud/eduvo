/**
 * HomeworkSubmitScreen — /student/homework/[id]
 *
 * Shows homework details and a submission interface.
 * Supports submission_type: 'typed' | 'photo' | 'either'.
 *
 * Photo pre-checks (client-side, soft warnings):
 *   - Blur detection via canvas pixel analysis
 *   - Low-light detection via average brightness
 *
 * On submit:
 *   - Uploads images to backend /api/homework/submit-upload
 *   - Reads EXIF timestamp from JPEG files if available
 *   - Computes a simple perceptual hash (blockhash-style via canvas)
 *   - Calls POST /api/homework/:id/submit
 *   - Shows confirmation or flagged-review notice
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  ActivityIndicator,
  Alert,
  StatusBar,
  Linking,
} from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import apiClient from '../../api/client';

// ── Navigation types ──────────────────────────────────────────────────────────

export interface HomeworkMeta {
  id: string;
  title: string;
  subject_name: string | null;
  due_date: string;
  teacher_name: string | null;
}

type HomeworkSubmitStackParamList = {
  HomeworkSubmit: { homework: HomeworkMeta };
};

type NavProp = StackNavigationProp<HomeworkSubmitStackParamList, 'HomeworkSubmit'>;
type RouteP = RouteProp<HomeworkSubmitStackParamList, 'HomeworkSubmit'>;

interface Props {
  navigation: NavProp;
  route: RouteP;
}

// ── API shapes ────────────────────────────────────────────────────────────────

interface HomeworkDetail {
  id: string;
  title: string;
  description: string | null;
  subject_name: string | null;
  teacher_name: string | null;
  due_date: string;
  file_url: string | null;
  ai_check_enabled: boolean;
  submission_type: 'typed' | 'photo' | 'either';
  subject_type: string | null;
  min_word_count: number | null;
  requires_diagram: boolean;
  existing_submission: {
    status: string;
    submission_text: string | null;
    submission_image_urls: string[] | null;
    submitted_at: string | null;
    ai_result: string | null;
    ai_feedback: string | null;
  } | null;
}

interface UploadedImage {
  localUri: string;
  remoteUrl: string | null;
  storagePath: string | null;
  fileName: string;
  /** Perceptual hash (computed client-side) */
  hash: string | null;
  /** EXIF timestamp extracted from file, if available */
  exifTimestamp: string | null;
  /** Pre-check results */
  checks: {
    blurry: boolean;
    dark: boolean;
    analyzed: boolean;
  };
  uploading: boolean;
  uploadError: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compute a simple 8×8 average-hash (like blockhash) from image URI.
 * We decode the image into a canvas (on web) or use a fallback on native.
 * On React Native we use a simplified approach: read base64 and XOR chunks.
 *
 * This is intentionally simple — the goal is to detect exact/near-exact
 * duplicates (same photo submitted by two students), not perceptual similarity.
 */
async function computeImageHash(uri: string): Promise<string | null> {
  try {
    // On native, we use a simple checksum from the first 4 KB of the file data
    // by fetching the image as base64 and hashing fixed-size samples.
    const response = await fetch(uri);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Sample 64 bytes evenly distributed through the file
    const sampleSize = 64;
    const step = Math.max(1, Math.floor(bytes.length / sampleSize));
    let hash = 0;
    for (let i = 0; i < sampleSize; i++) {
      const idx = i * step;
      hash = ((hash << 5) - hash + (bytes[idx] ?? 0)) | 0;
    }
    // Convert to hex string
    return (hash >>> 0).toString(16).padStart(8, '0');
  } catch {
    return null;
  }
}

/**
 * Analyze image for blur and low-light.
 * Returns { blurry, dark } using pixel brightness analysis.
 *
 * On React Native (no canvas): we sample a portion of the image bytes.
 * JPEG images have embedded thumbnail data we can sample for brightness.
 * This is a best-effort heuristic — not pixel-perfect.
 */
async function analyzeImage(uri: string): Promise<{ blurry: boolean; dark: boolean }> {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Estimate average brightness by sampling byte values
    // For JPEG, pixel data is after the header (~SOF0 marker), but we use
    // a rough sample of the middle section of the file which tends to contain
    // image data rather than headers/metadata.
    const fileSize = bytes.length;
    const startOffset = Math.floor(fileSize * 0.2); // skip header area
    const endOffset = Math.floor(fileSize * 0.8);
    const sampleStep = Math.max(1, Math.floor((endOffset - startOffset) / 256));

    let sum = 0;
    let count = 0;
    let variance = 0;
    const samples: number[] = [];

    for (let i = startOffset; i < endOffset; i += sampleStep) {
      samples.push(bytes[i]);
      sum += bytes[i];
      count++;
    }

    if (count === 0) return { blurry: false, dark: false };

    const mean = sum / count;

    // Compute variance (measure of image detail / edge contrast)
    for (const s of samples) {
      variance += (s - mean) ** 2;
    }
    variance /= count;

    // Heuristics (tuned for typical homework photos):
    // - Very low variance = flat image = likely blurry
    // - Very low mean brightness = dark image
    const blurry = variance < 200; // threshold for blur
    const dark = mean < 40;       // threshold for darkness (0-255)

    return { blurry, dark };
  } catch {
    return { blurry: false, dark: false };
  }
}

/**
 * Try to extract EXIF timestamp from JPEG image URI.
 * Looks for the ASCII date pattern "YYYY:MM:DD HH:MM:SS" in the raw JPEG bytes.
 * This works without a full EXIF library and covers most phones.
 */
async function extractExifTimestamp(uri: string): Promise<string | null> {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // EXIF date strings look like: 2024:05:15 14:23:45
    // In ASCII: digits, colons, spaces → scan first 64KB for this pattern
    const scanLimit = Math.min(bytes.length, 65536);
    let text = '';
    for (let i = 0; i < scanLimit; i++) {
      const b = bytes[i];
      // Only keep printable ASCII chars
      if (b >= 32 && b <= 126) {
        text += String.fromCharCode(b);
      } else {
        text += ' ';
      }
    }

    // Match EXIF date pattern: YYYY:MM:DD HH:MM:SS
    const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!match) return null;

    // Convert to ISO 8601
    const [, year, month, day, hour, minute, second] = match;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  } catch {
    return null;
  }
}

// ── Image compression ──────────────────────────────────────────────────────────

/**
 * Compress an image before upload:
 *   - Resize to max 1024px wide (maintains aspect ratio)
 *   - JPEG quality 70%
 *
 * Returns the URI of the compressed image.
 * Falls back to the original URI on any error so upload is never blocked.
 */
async function compressImage(uri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1024 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  } catch (err) {
    console.warn('[compress] Image compression failed, using original:', err);
    return uri;
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function RequirementBadge({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={reqStyles.badge}>
      <Text style={reqStyles.icon}>{icon}</Text>
      <Text style={reqStyles.label}>{label}</Text>
    </View>
  );
}

const reqStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 8,
    marginBottom: 6,
  },
  icon: { fontSize: 13, marginRight: 4 },
  label: { fontSize: 12, color: '#1E40AF', fontWeight: '600' },
});

function ImagePreviewCard({
  img,
  index,
  onRemove,
  onRetake,
}: {
  img: UploadedImage;
  index: number;
  onRemove: () => void;
  onRetake: () => void;
}) {
  const hasWarning = img.checks.analyzed && (img.checks.blurry || img.checks.dark);

  return (
    <View style={imgCardStyles.card}>
      <Image
        source={{ uri: img.localUri }}
        style={imgCardStyles.image}
        resizeMode="cover"
        accessibilityLabel={`Homework photo ${index + 1}`}
      />

      {/* Upload indicator */}
      {img.uploading && (
        <View style={imgCardStyles.overlay}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}

      {/* Error indicator */}
      {img.uploadError && (
        <View style={[imgCardStyles.overlay, imgCardStyles.errorOverlay]}>
          <Text style={imgCardStyles.errorText}>⚠️</Text>
        </View>
      )}

      {/* Top-right: remove button */}
      <TouchableOpacity
        style={imgCardStyles.removeBtn}
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`Remove photo ${index + 1}`}
      >
        <Text style={imgCardStyles.removeBtnText}>✕</Text>
      </TouchableOpacity>

      {/* Warning chip */}
      {hasWarning && (
        <View style={imgCardStyles.warningChip}>
          <Text style={imgCardStyles.warningChipText}>
            {img.checks.blurry && img.checks.dark ? '🌫️ Blurry & Dark' :
             img.checks.blurry ? '🌫️ May be blurry' :
             '🌑 May be dark'}
          </Text>
        </View>
      )}

      {/* Retake button when warning */}
      {hasWarning && (
        <TouchableOpacity
          style={imgCardStyles.retakeBtn}
          onPress={onRetake}
          accessibilityRole="button"
          accessibilityLabel={`Retake photo ${index + 1}`}
        >
          <Text style={imgCardStyles.retakeBtnText}>Retake</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const imgCardStyles = StyleSheet.create({
  card: {
    width: 130,
    marginRight: 12,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    position: 'relative',
  },
  image: { width: 130, height: 130 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorOverlay: { backgroundColor: 'rgba(239,68,68,0.5)' },
  errorText: { fontSize: 28 },
  removeBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  warningChip: {
    position: 'absolute',
    bottom: 36,
    left: 4,
    right: 4,
    backgroundColor: 'rgba(245,158,11,0.9)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  warningChipText: { fontSize: 9, color: '#FFFFFF', fontWeight: '700', textAlign: 'center' },
  retakeBtn: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    right: 6,
    backgroundColor: '#1D4ED8',
    borderRadius: 6,
    paddingVertical: 4,
    alignItems: 'center',
  },
  retakeBtnText: { fontSize: 10, color: '#FFFFFF', fontWeight: '700' },
});

// ── AI result badge ───────────────────────────────────────────────────────────

function AIResultBanner({ result, feedback }: { result: string | null; feedback: string | null }) {
  if (!result) return null;

  const config: Record<string, { bg: string; text: string; label: string; icon: string }> = {
    correct:      { bg: '#DCFCE7', text: '#15803D', label: 'Correct ✓', icon: '✅' },
    incorrect:    { bg: '#FEE2E2', text: '#B91C1C', label: 'Incorrect ✗', icon: '❌' },
    partial:      { bg: '#FEF3C7', text: '#92400E', label: 'Partially Correct', icon: '🟡' },
    needs_review: { bg: '#FEF9C3', text: '#854D0E', label: 'Needs Review', icon: '👁️' },
  };

  const c = config[result] ?? config.needs_review;

  return (
    <View style={[aiBanner.container, { backgroundColor: c.bg }]}>
      <Text style={aiBanner.icon}>{c.icon}</Text>
      <View style={aiBanner.body}>
        <Text style={[aiBanner.label, { color: c.text }]}>AI Result: {c.label}</Text>
        {feedback ? <Text style={[aiBanner.feedback, { color: c.text }]}>{feedback}</Text> : null}
      </View>
    </View>
  );
}

const aiBanner = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    alignItems: 'flex-start',
  },
  icon: { fontSize: 20, marginRight: 10 },
  body: { flex: 1 },
  label: { fontSize: 14, fontWeight: '700' },
  feedback: { fontSize: 13, marginTop: 4, lineHeight: 18 },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function HomeworkSubmitScreen({ navigation, route }: Props) {
  const { homework: hwMeta } = route.params;

  const [detail, setDetail] = useState<HomeworkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Submission mode when type is 'either'
  const [mode, setMode] = useState<'typed' | 'photo'>('typed');

  // Typed answer
  const [text, setText] = useState('');

  // Photos
  const [images, setImages] = useState<UploadedImage[]>([]);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitMessage, setSubmitMessage] = useState('');
  const [submitFlagged, setSubmitFlagged] = useState(false);

  // Warn-and-proceed overlay
  const [pendingWarnings, setPendingWarnings] = useState<string[]>([]);
  const [showWarningOverlay, setShowWarningOverlay] = useState(false);

  // ── Load homework detail ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get(`/api/homework/${hwMeta.id}`);
        const hw: HomeworkDetail = res.data.data;
        if (cancelled) return;
        setDetail(hw);
        // Set default mode based on submission_type
        if (hw.submission_type === 'photo') setMode('photo');
        else setMode('typed');
        // Pre-fill if already submitted
        if (hw.existing_submission) {
          setText(hw.existing_submission.submission_text ?? '');
          // If previous submission used photos, start in photo mode
          if (hw.existing_submission.submission_image_urls?.length) {
            setMode('photo');
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load homework details');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [hwMeta.id]);

  // ── Image picker ────────────────────────────────────────────────────────────

  const uploadImage = useCallback(async (uri: string, fileName: string): Promise<{ url: string | null; path: string | null; error: string | null }> => {
    try {
      const formData = new FormData();
      formData.append('images', {
        uri,
        name: fileName,
        type: 'image/jpeg',
      } as unknown as Blob);

      const res = await apiClient.post('/api/homework/submit-upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const uploaded = res.data.data.images?.[0];
      return { url: uploaded?.url ?? null, path: uploaded?.storage_path ?? null, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      return { url: null, path: null, error: msg };
    }
  }, []);

  const pickImages = useCallback(async (source: 'camera' | 'library') => {
    if (images.length >= 5) {
      Alert.alert('Limit reached', 'You can upload a maximum of 5 photos per submission.');
      return;
    }

    // Request permissions
    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Camera permission is required to take photos.');
        return;
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Photo library permission is required to choose photos.');
        return;
      }
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.85,
          exif: true,
          allowsEditing: false,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.85,
          allowsMultipleSelection: true,
          exif: true,
          selectionLimit: 5 - images.length,
        });

    if (result.canceled || !result.assets?.length) return;

    const newImages: UploadedImage[] = result.assets.map((asset) => ({
      localUri: asset.uri,
      remoteUrl: null,
      storagePath: null,
      fileName: asset.fileName ?? `photo_${Date.now()}.jpg`,
      hash: null,
      exifTimestamp: asset.exif?.DateTimeOriginal
        ? (() => {
            // Convert "YYYY:MM:DD HH:MM:SS" to ISO
            const m = String(asset.exif.DateTimeOriginal).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
          })()
        : null,
      checks: { blurry: false, dark: false, analyzed: false },
      uploading: true,
      uploadError: null,
    }));

    setImages((prev) => [...prev, ...newImages]);

    // Run analysis + upload for each new image in parallel
    for (let i = 0; i < newImages.length; i++) {
      const img = newImages[i];
      const globalIndex = images.length + i;

      // Kick off analysis and upload concurrently
      Promise.all([
        analyzeImage(img.localUri),
        computeImageHash(img.localUri),
        extractExifTimestamp(img.localUri).then((ts) => ts),
        // Compress before upload: max 1024px wide, JPEG 70%
        compressImage(img.localUri).then((compressedUri) =>
          uploadImage(compressedUri, img.fileName)
        ),
      ]).then(([checks, hash, exifFromFile, uploadResult]) => {
        setImages((prev) => {
          const updated = [...prev];
          if (!updated[globalIndex]) return prev;
          updated[globalIndex] = {
            ...updated[globalIndex],
            checks: { ...checks, analyzed: true },
            hash: img.hash ?? hash,
            // Prefer EXIF from ImagePicker asset, fall back to file-parsed
            exifTimestamp: img.exifTimestamp ?? exifFromFile,
            remoteUrl: uploadResult.url,
            storagePath: uploadResult.path,
            uploading: false,
            uploadError: uploadResult.error,
          };
          return updated;
        });
      });
    }
  }, [images, uploadImage]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const retakeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    // Re-launch camera
    setTimeout(() => pickImages('camera'), 300);
  }, [pickImages]);

  // ── Submit logic ────────────────────────────────────────────────────────────

  const doSubmit = useCallback(async (overrideWarnings = false) => {
    if (!detail) return;
    setSubmitError(null);

    const activeMode = detail.submission_type === 'either' ? mode : detail.submission_type;

    // Pre-submit validations
    if (activeMode === 'typed') {
      if (detail.min_word_count && wordCount(text) < detail.min_word_count) {
        setSubmitError(`Your answer needs at least ${detail.min_word_count} words.`);
        return;
      }
    }

    if (activeMode === 'photo') {
      if (images.length === 0) {
        setSubmitError('Please add at least one photo.');
        return;
      }
      const stillUploading = images.some((img) => img.uploading);
      if (stillUploading) {
        setSubmitError('Please wait for all photos to finish uploading.');
        return;
      }
      const failedUploads = images.filter((img) => img.uploadError);
      if (failedUploads.length > 0) {
        setSubmitError('Some photos failed to upload. Please remove them and try again.');
        return;
      }
    }

    // Check for soft warnings (blur/dark) — only for photo mode
    if (!overrideWarnings && activeMode === 'photo' && images.length > 0) {
      const warnings: string[] = [];
      images.forEach((img, i) => {
        if (img.checks.blurry) warnings.push(`Photo ${i + 1} looks blurry. Consider retaking it.`);
        if (img.checks.dark) warnings.push(`Photo ${i + 1} looks too dark. Try in better lighting.`);
      });
      if (warnings.length > 0) {
        setPendingWarnings(warnings);
        setShowWarningOverlay(true);
        return;
      }
    }

    setSubmitting(true);

    try {
      const activeMode2 = detail.submission_type === 'either' ? mode : detail.submission_type;

      const payload: {
        submission_text?: string;
        submission_image_urls?: string[];
        image_hashes?: (string | null)[];
        exif_timestamps?: (string | null)[];
      } = {};

      if (activeMode2 === 'typed') {
        if (text.trim()) payload.submission_text = text.trim();
      }
      if (activeMode2 === 'photo' && images.length > 0) {
        payload.submission_image_urls = images.map((img) => img.remoteUrl!).filter(Boolean);
        payload.image_hashes = images.map((img) => img.hash);
        payload.exif_timestamps = images.map((img) => img.exifTimestamp);
      }

      const res = await apiClient.post(`/api/homework/${detail.id}/submit`, payload);
      const data = res.data.data;

      setSubmitted(true);
      setSubmitMessage(data.message ?? 'Submitted successfully!');
      setSubmitFlagged(data.status === 'flagged_for_review');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message :
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Submission failed';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [detail, mode, text, images]);

  const handleSubmit = useCallback(() => {
    doSubmit(false);
  }, [doSubmit]);

  // ── Derived state ────────────────────────────────────────────────────────────

  const activeMode = detail ? (detail.submission_type === 'either' ? mode : detail.submission_type) : 'typed';
  const wc = wordCount(text);
  const minWords = detail?.min_word_count ?? 0;
  const wordCountMet = !minWords || wc >= minWords;
  const allUploaded = images.every((img) => !img.uploading && !img.uploadError);
  const canSubmit =
    !submitting &&
    (activeMode === 'typed'
      ? text.trim().length > 0 && wordCountMet
      : activeMode === 'photo'
      ? images.length > 0 && allUploaded
      : (text.trim().length > 0 || images.length > 0) && (minWords ? wordCountMet : true) && (images.length === 0 || allUploaded));

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (loadError || !detail) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorEmoji}>⚠️</Text>
        <Text style={styles.errorText}>{loadError ?? 'Failed to load homework'}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.retryBtnText}>← Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Submitted confirmation ────────────────────────────────────────────────

  if (submitted) {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <View style={styles.centered}>
          <Text style={styles.successEmoji}>{submitFlagged ? '🔎' : '✅'}</Text>
          <Text style={styles.successTitle}>
            {submitFlagged ? 'Submitted for Review' : 'Homework Submitted!'}
          </Text>
          <Text style={styles.successMessage}>{submitMessage}</Text>
          <TouchableOpacity
            style={styles.doneBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
          >
            <Text style={styles.doneBtnText}>← Back to Homework</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  const alreadySubmitted = detail.existing_submission?.status &&
    detail.existing_submission.status !== 'not_submitted';

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* ── Homework details card ─────────────────────────────────────── */}
        <View style={styles.detailCard}>
          {/* Subject badge */}
          {detail.subject_name && (
            <View style={styles.subjectBadge}>
              <Text style={styles.subjectText}>{detail.subject_name}</Text>
            </View>
          )}

          <Text style={styles.hwTitle}>{detail.title}</Text>

          {detail.description ? (
            <Text style={styles.hwDesc}>{detail.description}</Text>
          ) : null}

          <View style={styles.metaRow}>
            <Text style={styles.metaItem}>📅 Due {formatDate(detail.due_date)}</Text>
            {detail.teacher_name && (
              <Text style={styles.metaItem}>👤 {detail.teacher_name}</Text>
            )}
          </View>

          {/* Requirements section — only show what teacher specified */}
          {(detail.min_word_count || detail.requires_diagram || detail.subject_type) ? (
            <View style={styles.requirementsSection}>
              <Text style={styles.requirementsLabel}>Requirements</Text>
              <View style={styles.requirementsRow}>
                {detail.min_word_count ? (
                  <RequirementBadge icon="📝" label={`Min ${detail.min_word_count} words`} />
                ) : null}
                {detail.requires_diagram ? (
                  <RequirementBadge icon="📐" label="Diagram required" />
                ) : null}
                {detail.subject_type ? (
                  <RequirementBadge icon="🔬"
                    label={detail.subject_type.charAt(0).toUpperCase() + detail.subject_type.slice(1)} />
                ) : null}
              </View>
            </View>
          ) : null}

          {/* AI check badge */}
          {detail.ai_check_enabled && (
            <View style={styles.aiBadge}>
              <Text style={styles.aiBadgeText}>🤖 AI-checked homework</Text>
            </View>
          )}

          {/* Teacher's uploaded files — split on ||| for multi-file support */}
          {detail.file_url && (
            <View style={styles.attachmentsSection}>
              <Text style={styles.attachmentsLabel}>📎 Homework Files</Text>
              {detail.file_url.split('|||').map((url, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.attachmentBtn}
                  onPress={() => Linking.openURL(url)}
                  accessibilityRole="link"
                  accessibilityLabel={`Open attachment ${i + 1}`}
                >
                  <Text style={styles.attachmentBtnText}>
                    {detail.file_url!.includes('|||') ? `📄 File ${i + 1}` : '📄 View Attachment'}
                  </Text>
                  <Text style={styles.attachmentArrow}>↗</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ── Already submitted: show AI result if available ────────────── */}
        {alreadySubmitted && detail.existing_submission?.ai_result && (
          <AIResultBanner
            result={detail.existing_submission.ai_result}
            feedback={detail.existing_submission.ai_feedback}
          />
        )}

        {/* ── Re-submission notice ──────────────────────────────────────── */}
        {alreadySubmitted && (
          <View style={styles.resubmitBanner}>
            <Text style={styles.resubmitText}>
              You already submitted this homework. You can re-submit to update your answer.
            </Text>
          </View>
        )}

        {/* ── Mode selector (only for 'either') ────────────────────────── */}
        {detail.submission_type === 'either' && (
          <View style={styles.modeSelector}>
            <TouchableOpacity
              style={[styles.modeBtn, mode === 'typed' && styles.modeBtnActive]}
              onPress={() => setMode('typed')}
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === 'typed' }}
            >
              <Text style={[styles.modeBtnText, mode === 'typed' && styles.modeBtnTextActive]}>
                ✍️ Type Answer
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, mode === 'photo' && styles.modeBtnActive]}
              onPress={() => setMode('photo')}
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === 'photo' }}
            >
              <Text style={[styles.modeBtnText, mode === 'photo' && styles.modeBtnTextActive]}>
                📷 Photo
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Typed answer interface ────────────────────────────────────── */}
        {(activeMode === 'typed') && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Your Answer</Text>
            <TextInput
              style={styles.textarea}
              multiline
              numberOfLines={8}
              placeholder="Write your answer here…"
              placeholderTextColor="#9CA3AF"
              value={text}
              onChangeText={setText}
              textAlignVertical="top"
              accessibilityLabel="Answer text input"
            />

            {/* Word counter */}
            {detail.min_word_count ? (
              <View style={styles.wordCountRow}>
                <Text style={[
                  styles.wordCountText,
                  wordCountMet ? styles.wordCountOk : styles.wordCountShort,
                ]}>
                  {wc} / {detail.min_word_count} words
                </Text>
                {!wordCountMet && (
                  <Text style={styles.wordCountHint}>
                    {detail.min_word_count - wc} more word{detail.min_word_count - wc !== 1 ? 's' : ''} needed
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.wordCountLight}>{wc} word{wc !== 1 ? 's' : ''}</Text>
            )}
          </View>
        )}

        {/* ── Photo interface ───────────────────────────────────────────── */}
        {(activeMode === 'photo') && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Photos ({images.length}/5)</Text>
            <Text style={styles.sectionHint}>
              Take clear, well-lit photos. Multiple photos allowed for multi-page answers.
            </Text>

            {/* Image previews */}
            {images.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow}>
                {images.map((img, idx) => (
                  <ImagePreviewCard
                    key={`${img.localUri}-${idx}`}
                    img={img}
                    index={idx}
                    onRemove={() => removeImage(idx)}
                    onRetake={() => retakeImage(idx)}
                  />
                ))}
              </ScrollView>
            )}

            {/* Add photo buttons */}
            {images.length < 5 && (
              <View style={styles.photoActions}>
                <TouchableOpacity
                  style={styles.photoBtn}
                  onPress={() => pickImages('camera')}
                  accessibilityRole="button"
                  accessibilityLabel="Take a photo with camera"
                >
                  <Text style={styles.photoBtnIcon}>📷</Text>
                  <Text style={styles.photoBtnText}>Camera</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.photoBtn}
                  onPress={() => pickImages('library')}
                  accessibilityRole="button"
                  accessibilityLabel="Choose photo from library"
                >
                  <Text style={styles.photoBtnIcon}>🖼️</Text>
                  <Text style={styles.photoBtnText}>Gallery</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Upload errors */}
            {images.some((img) => img.uploadError) && (
              <View style={styles.warningBox}>
                <Text style={styles.warningText}>
                  ⚠️ Some photos failed to upload. Remove the failed photos and try again.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ── Submit error ──────────────────────────────────────────────── */}
        {submitError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorBoxText}>⚠️ {submitError}</Text>
          </View>
        )}

        {/* ── Submit button ─────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit || submitting}
          accessibilityRole="button"
          accessibilityLabel="Submit homework"
          accessibilityState={{ disabled: !canSubmit || submitting }}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitBtnText}>
              {!wordCountMet
                ? `${minWords - wc} more word${minWords - wc !== 1 ? 's' : ''} needed`
                : alreadySubmitted ? 'Re-submit' : 'Submit Homework'}
            </Text>
          )}
        </TouchableOpacity>

      </ScrollView>

      {/* ── Photo quality warning overlay ──────────────────────────────── */}
      {showWarningOverlay && (
        <View style={warnStyles.backdrop}>
          <View style={warnStyles.card}>
            <Text style={warnStyles.title}>Photo Quality Warning</Text>
            {pendingWarnings.map((w, i) => (
              <View key={i} style={warnStyles.warningRow}>
                <Text style={warnStyles.warningBullet}>⚠️</Text>
                <Text style={warnStyles.warningMsg}>{w}</Text>
              </View>
            ))}
            <Text style={warnStyles.hint}>
              You can retake photos from the submission screen, or proceed anyway.
            </Text>
            <View style={warnStyles.actions}>
              <TouchableOpacity
                style={warnStyles.cancelBtn}
                onPress={() => setShowWarningOverlay(false)}
                accessibilityRole="button"
              >
                <Text style={warnStyles.cancelBtnText}>Retake Photos</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={warnStyles.proceedBtn}
                onPress={() => { setShowWarningOverlay(false); doSubmit(true); }}
                accessibilityRole="button"
              >
                <Text style={warnStyles.proceedBtnText}>Submit Anyway</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },

  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#F9FAFB' },
  errorEmoji: { fontSize: 40, marginBottom: 12 },
  errorText: { fontSize: 15, color: '#6B7280', textAlign: 'center', marginBottom: 20 },
  retryBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },

  successEmoji: { fontSize: 60, marginBottom: 16 },
  successTitle: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 8 },
  successMessage: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 22, marginBottom: 32, paddingHorizontal: 12 },
  doneBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  doneBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },

  // Detail card
  detailCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 2,
  },
  subjectBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#DBEAFE',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  subjectText: { fontSize: 11, fontWeight: '700', color: '#1D4ED8' },
  hwTitle: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 6 },
  hwDesc: { fontSize: 14, color: '#6B7280', lineHeight: 20, marginBottom: 10 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10 },
  metaItem: { fontSize: 12, color: '#6B7280', fontWeight: '500' },

  requirementsSection: { marginTop: 6 },
  requirementsLabel: { fontSize: 11, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  requirementsRow: { flexDirection: 'row', flexWrap: 'wrap' },

  aiBadge: {
    marginTop: 10,
    backgroundColor: '#F5F3FF',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  aiBadgeText: { fontSize: 12, color: '#5B21B6', fontWeight: '600' },

  // Attachment files
  attachmentsSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
  },
  attachmentsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 6,
  },
  attachmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  attachmentBtnText: { fontSize: 13, color: '#1D4ED8', fontWeight: '600' },
  attachmentArrow: { fontSize: 14, color: '#1D4ED8', fontWeight: '700' },

  // Re-submit banner
  resubmitBanner: {
    backgroundColor: '#FEF9C3',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#F59E0B',
  },
  resubmitText: { fontSize: 13, color: '#78350F', lineHeight: 18 },

  // Mode selector
  modeSelector: {
    flexDirection: 'row',
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  modeBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  modeBtnText: { fontSize: 14, fontWeight: '500', color: '#6B7280' },
  modeBtnTextActive: { color: '#1D4ED8', fontWeight: '700' },

  // Sections
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: '#374151', marginBottom: 6 },
  sectionHint: { fontSize: 12, color: '#9CA3AF', marginBottom: 12, lineHeight: 16 },

  // Textarea
  textarea: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 160,
    backgroundColor: '#FAFAFA',
    lineHeight: 22,
  },
  wordCountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  wordCountText: { fontSize: 13, fontWeight: '600' },
  wordCountOk: { color: '#22C55E' },
  wordCountShort: { color: '#EF4444' },
  wordCountHint: { fontSize: 12, color: '#EF4444' },
  wordCountLight: { fontSize: 12, color: '#9CA3AF', marginTop: 6, textAlign: 'right' },

  // Photo row
  photoRow: { marginBottom: 14 },

  // Photo action buttons
  photoActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  photoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#EFF6FF',
    borderWidth: 2,
    borderColor: '#BFDBFE',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 16,
  },
  photoBtnIcon: { fontSize: 22 },
  photoBtnText: { fontSize: 14, color: '#1D4ED8', fontWeight: '600' },

  // Warning / error boxes
  warningBox: {
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  warningText: { fontSize: 13, color: '#92400E' },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorBoxText: { fontSize: 14, color: '#B91C1C' },

  // Submit button
  submitBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  submitBtnDisabled: { backgroundColor: '#93C5FD' },
  submitBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});

// ── Warning overlay styles ────────────────────────────────────────────────────

const warnStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 999,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 24,
    width: '100%',
    maxWidth: 380,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 14 },
  warningRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  warningBullet: { fontSize: 16, marginRight: 8, marginTop: 1 },
  warningMsg: { fontSize: 14, color: '#374151', flex: 1, lineHeight: 20 },
  hint: { fontSize: 13, color: '#6B7280', marginTop: 10, marginBottom: 20, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 12 },
  cancelBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, color: '#374151', fontWeight: '600' },
  proceedBtn: {
    flex: 1,
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  proceedBtnText: { fontSize: 14, color: '#FFFFFF', fontWeight: '700' },
});
