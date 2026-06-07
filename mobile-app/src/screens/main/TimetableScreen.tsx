import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Image,
  Linking,
  Dimensions,
} from 'react-native';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ── Types ─────────────────────────────────────────────────────────────────────

interface Period {
  id: string;
  period_number: number;
  start_time: string;
  end_time: string;
  subject_name: string;
  teacher_name: string;
  day: string;
}

interface UploadedFile {
  public_url: string;
  file_name: string | null;
  uploaded_at: string;
  is_image: boolean;
}

// Shape returned by GET /api/timetable/class — day-keyed object
type TimetableByDayRaw = Record<
  string,
  Array<{
    id: string;
    period: number;
    start_time: string;
    end_time: string;
    subject_name: string | null;
    teacher_name: string | null;
    subject_id: string;
    teacher_id: string;
    class_name: string;
    section: string;
  }>
>;

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Assign a consistent color per subject (hash-based)
const SUBJECT_COLORS = [
  '#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#FFEDD5',
  '#E0F2FE', '#F0FDF4', '#FFF7ED', '#F5F3FF',
];

function subjectColor(subject: string): string {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = subject.charCodeAt(i) + ((hash << 5) - hash);
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
}

function subjectTextColor(subject: string): string {
  const colors = [
    '#1D4ED8', '#15803D', '#92400E', '#9D174D', '#5B21B6', '#C2410C',
    '#0369A1', '#166534', '#C2410C', '#4C1D95',
  ];
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = subject.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function todayDayIndex(): number {
  const day = new Date().getDay(); // 0=Sun
  if (day === 0) return 0; // Sunday → show Monday
  return Math.min(day - 1, 5); // Mon=0 ... Sat=5
}

function formatUploadDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// ── Period card ───────────────────────────────────────────────────────────────

function PeriodCard({ period }: { period: Period }) {
  const bg = subjectColor(period.subject_name);
  const textColor = subjectTextColor(period.subject_name);

  return (
    <View style={[periodStyles.card, { backgroundColor: bg }]}>
      <View style={[periodStyles.colorBar, { backgroundColor: textColor }]} />
      <View style={periodStyles.body}>
        <View style={periodStyles.timeRow}>
          <Text style={[periodStyles.time, { color: textColor }]}>
            {period.start_time} – {period.end_time}
          </Text>
          <Text style={periodStyles.periodNum}>Period {period.period_number}</Text>
        </View>
        <Text style={[periodStyles.subject, { color: textColor }]}>{period.subject_name}</Text>
        {period.teacher_name ? (
          <Text style={periodStyles.teacher}>👤 {period.teacher_name}</Text>
        ) : null}
      </View>
    </View>
  );
}

const periodStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  colorBar: { width: 4 },
  body: { flex: 1, padding: 14 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  time: { fontSize: 12, fontWeight: '600' },
  periodNum: { fontSize: 11, color: '#9CA3AF' },
  subject: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  teacher: { fontSize: 12, color: '#6B7280' },
});

// ── Uploaded file viewer ──────────────────────────────────────────────────────

function UploadedTimetableView({
  file,
  onRefresh,
  refreshing,
}: {
  file: UploadedFile;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [imageError, setImageError] = useState(false);
  const [imageHeight, setImageHeight] = useState(SCREEN_WIDTH * 1.4); // default tall aspect

  async function openPdf() {
    try {
      await Linking.openURL(file.public_url);
    } catch {
      // silently ignore — user can long-press to copy
    }
  }

  return (
    <ScrollView
      style={styles.periodsScroll}
      contentContainerStyle={styles.fileViewContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
      }
    >
      {/* Upload metadata */}
      <View style={fileStyles.metaRow}>
        <Text style={fileStyles.metaText}>
          📎 {file.file_name ?? 'Timetable'}{' '}
          {file.uploaded_at ? `· Updated ${formatUploadDate(file.uploaded_at)}` : ''}
        </Text>
      </View>

      {file.is_image && !imageError ? (
        /* Render image directly */
        <View style={fileStyles.imageWrapper}>
          <Image
            source={{ uri: file.public_url }}
            style={[fileStyles.image, { height: imageHeight }]}
            resizeMode="contain"
            onError={() => setImageError(true)}
            onLoad={(e) => {
              const { width, height } = e.nativeEvent.source;
              if (width && height) {
                setImageHeight((SCREEN_WIDTH - 32) * (height / width));
              }
            }}
          />
        </View>
      ) : (
        /* PDF or image load failed — show open button */
        <View style={fileStyles.pdfBox}>
          <Text style={fileStyles.pdfIcon}>📄</Text>
          <Text style={fileStyles.pdfTitle}>
            {file.file_name ?? 'Timetable.pdf'}
          </Text>
          <Text style={fileStyles.pdfHint}>
            Tap the button below to open the timetable
          </Text>
          <TouchableOpacity style={fileStyles.openBtn} onPress={openPdf} activeOpacity={0.8}>
            <Text style={fileStyles.openBtnText}>Open Timetable</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const fileStyles = StyleSheet.create({
  metaRow: {
    paddingHorizontal: 4,
    paddingBottom: 12,
  },
  metaText: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
  },
  imageWrapper: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  image: {
    width: SCREEN_WIDTH - 32,
  },
  pdfBox: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  pdfIcon: { fontSize: 56, marginBottom: 16 },
  pdfTitle: { fontSize: 16, fontWeight: '600', color: '#111827', marginBottom: 8, textAlign: 'center' },
  pdfHint: { fontSize: 13, color: '#9CA3AF', marginBottom: 24, textAlign: 'center' },
  openBtn: {
    backgroundColor: '#1D4ED8',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  openBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function TimetableScreen() {
  const student = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const activeStudent = linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;

  const [selectedDay, setSelectedDay] = useState(todayDayIndex());

  // Structured (day-by-day) timetable data
  const [timetable, setTimetable] = useState<Record<string, Period[]>>({});

  // Uploaded file (image or PDF)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);

  // true while either fetch is in progress on first load
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);

    try {
      // Fetch uploaded file and structured timetable in parallel
      const [fileRes, ttRes] = await Promise.allSettled([
        apiClient.get('/api/timetable/file', {
          params: {
            class: activeStudent?.class,
            section: activeStudent?.section,
          },
        }),
        apiClient.get('/api/timetable/class', {
          params: {
            class: activeStudent?.class,
            section: activeStudent?.section,
          },
        }),
      ]);

      // ── Handle uploaded file ────────────────────────────────────────────────
      if (fileRes.status === 'fulfilled') {
        const fileData = fileRes.value.data?.data ?? null;
        setUploadedFile(fileData?.public_url ? fileData : null);
      } else {
        setUploadedFile(null);
      }

      // ── Handle structured timetable ─────────────────────────────────────────
      if (ttRes.status === 'fulfilled') {
        const raw: TimetableByDayRaw = ttRes.value.data?.data ?? {};
        const grouped: Record<string, Period[]> = {};
        for (const [dayKey, entries] of Object.entries(raw)) {
          const dayName = dayKey.charAt(0).toUpperCase() + dayKey.slice(1);
          const periods: Period[] = entries.map((e) => ({
            id: e.id,
            period_number: e.period,
            start_time: e.start_time,
            end_time: e.end_time,
            subject_name: e.subject_name ?? 'Unknown Subject',
            teacher_name: e.teacher_name ?? '',
            day: dayName,
          }));
          periods.sort((a, b) => a.period_number - b.period_number);
          grouped[dayName] = periods;
        }
        setTimetable(grouped);
      }
    } catch (err) {
      console.warn('[Timetable] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.class, activeStudent?.section]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll(true);
  }, [fetchAll]);

  // ── Determine which view to show ──────────────────────────────────────────
  // If a teacher uploaded an image/PDF → show it directly.
  // Only fall back to day-by-day when there's no uploaded file.
  const showUploadedFile = !loading && uploadedFile !== null;

  const currentDayName = DAYS[selectedDay];
  const periods = timetable[currentDayName] ?? [];

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <View style={[styles.container, styles.centered]}>
          <ActivityIndicator size="large" color="#1D4ED8" />
        </View>
      </>
    );
  }

  // ── Uploaded file view ────────────────────────────────────────────────────
  if (showUploadedFile) {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <View style={styles.container}>
          <UploadedTimetableView
            file={uploadedFile!}
            onRefresh={onRefresh}
            refreshing={refreshing}
          />
        </View>
      </>
    );
  }

  // ── Day-by-day view (structured timetable) ────────────────────────────────
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.container}>
        {/* Day tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.dayTabsScroll}
          contentContainerStyle={styles.dayTabsContent}
        >
          {DAYS.map((day, idx) => (
            <TouchableOpacity
              key={day}
              style={[styles.dayTab, selectedDay === idx && styles.dayTabActive]}
              onPress={() => setSelectedDay(idx)}
              accessibilityRole="tab"
              accessibilityLabel={day}
              accessibilityState={{ selected: selectedDay === idx }}
            >
              <Text style={[styles.dayTabText, selectedDay === idx && styles.dayTabTextActive]}>
                {DAY_SHORT[idx]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Periods list */}
        <ScrollView
          style={styles.periodsScroll}
          contentContainerStyle={styles.periodsContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
          }
        >
          <Text style={styles.dayTitle}>{currentDayName}</Text>

          {periods.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📅</Text>
              <Text style={styles.emptyText}>No classes scheduled for {currentDayName}.</Text>
            </View>
          ) : (
            periods.map((period) => (
              <PeriodCard key={period.id} period={period} />
            ))
          )}
        </ScrollView>
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { justifyContent: 'center', alignItems: 'center' },
  dayTabsScroll: {
    maxHeight: 52,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  dayTabsContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
  },
  dayTab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  dayTabActive: { backgroundColor: '#1D4ED8' },
  dayTabText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  dayTabTextActive: { color: '#FFFFFF' },
  periodsScroll: { flex: 1 },
  periodsContent: { padding: 20, paddingBottom: 48 },
  fileViewContent: { padding: 16, paddingBottom: 48 },
  dayTitle: { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 16 },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
});
