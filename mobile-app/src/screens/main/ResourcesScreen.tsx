/**
 * ResourcesScreen — Subject-wise Notes & Assignments for students/parents.
 *
 * Shows subject tabs; each tab lists resources for that subject.
 * "New" badge for items uploaded in the last 48 hours.
 * PDFs open in browser; images shown as tappable thumbnails.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Linking,
  Image,
  Modal,
  Dimensions,
  Platform,
} from 'react-native';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResourceItem {
  id: string;
  school_id: string;
  teacher_id: string;
  class: string;
  section: string;
  subject: string;
  title: string;
  description: string | null;
  resource_type: 'note' | 'assignment';
  file_urls: string[];
  due_date: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
}

function isPdfUrl(url: string): boolean {
  return /\.pdf(\?.*)?$/i.test(url);
}

/** Returns true if the resource was uploaded within the last 48 hours. */
function isNew(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < 48 * 60 * 60 * 1000;
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(day).padStart(2,'0')} ${months[month - 1]} ${year}`;
}

/** Check if due_date is overdue (before today). */
function isOverdue(dateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) < today;
}

/** Check if due_date is within 2 days (including today). */
function isDueSoon(dateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due.getTime() - today.getTime()) / 86400000);
  return diff >= 0 && diff <= 2;
}

function fileBaseName(url: string, idx: number): string {
  try {
    const parts = decodeURIComponent(new URL(url).pathname).split('/');
    const name = parts[parts.length - 1] ?? '';
    if (!name) return `File ${idx + 1}`;
    return name.length > 32 ? name.slice(0, 29) + '…' : name;
  } catch {
    return `File ${idx + 1}`;
  }
}

// Colour palette for subject tabs
const SUBJECT_PALETTE = [
  { bg: '#DBEAFE', text: '#1D4ED8', tab: '#1D4ED8' },
  { bg: '#DCFCE7', text: '#15803D', tab: '#15803D' },
  { bg: '#FEF3C7', text: '#92400E', tab: '#D97706' },
  { bg: '#FCE7F3', text: '#9D174D', tab: '#DB2777' },
  { bg: '#EDE9FE', text: '#5B21B6', tab: '#7C3AED' },
  { bg: '#FFEDD5', text: '#C2410C', tab: '#EA580C' },
  { bg: '#CFFAFE', text: '#155E75', tab: '#0891B2' },
  { bg: '#F0FDF4', text: '#166534', tab: '#16A34A' },
];

const subjectPaletteCache: Record<string, (typeof SUBJECT_PALETTE)[number]> = {};

function paletteFor(subject: string) {
  if (!subjectPaletteCache[subject]) {
    const idx = Object.keys(subjectPaletteCache).length % SUBJECT_PALETTE.length;
    subjectPaletteCache[subject] = SUBJECT_PALETTE[idx];
  }
  return subjectPaletteCache[subject];
}

// ── Image lightbox ────────────────────────────────────────────────────────────

function ImageLightbox({
  url,
  visible,
  onClose,
}: {
  url: string;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={lightboxStyles.overlay}
        activeOpacity={1}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close image"
      >
        <Image
          source={{ uri: url }}
          style={lightboxStyles.image}
          resizeMode="contain"
          accessibilityLabel="Full-size image"
        />
        <View style={lightboxStyles.closeBtn}>
          <Text style={lightboxStyles.closeTxt}>✕ Close</Text>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const lightboxStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: SCREEN_WIDTH - 32,
    height: SCREEN_WIDTH - 32,
  },
  closeBtn: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
  },
  closeTxt: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});

// ── Resource card ─────────────────────────────────────────────────────────────

function ResourceCard({ item }: { item: ResourceItem }) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fresh = isNew(item.created_at);
  const palette = paletteFor(item.subject);

  const overdue = item.due_date ? isOverdue(item.due_date) : false;

  async function openFile(url: string) {
    if (isImageUrl(url)) {
      setLightboxUrl(url);
      return;
    }
    // For PDFs, use Google Docs viewer so it opens reliably in the browser
    // on any Android device regardless of whether a local PDF app is installed.
    const viewerUrl = isPdfUrl(url)
      ? `https://docs.google.com/gviewer?embedded=true&url=${encodeURIComponent(url)}`
      : url;

    try {
      await Linking.openURL(viewerUrl);
    } catch {
      // Last resort: try the raw URL directly
      try {
        await Linking.openURL(url);
      } catch (e) {
        console.warn('[ResourcesScreen] Could not open file:', url, e);
      }
    }
  }

  return (
    <View style={cardStyles.card}>
      {/* Header row */}
      <View style={cardStyles.headerRow}>
        <View style={[cardStyles.typeBadge,
          item.resource_type === 'note'
            ? cardStyles.noteBadge
            : cardStyles.assignmentBadge
        ]}>
          <Text style={[cardStyles.typeText,
            item.resource_type === 'note'
              ? cardStyles.noteText
              : cardStyles.assignmentText
          ]}>
            {item.resource_type === 'note' ? '📚 Note' : '📝 Assignment'}
          </Text>
        </View>

        {fresh && (
          <View style={cardStyles.newBadge}>
            <Text style={cardStyles.newText}>NEW</Text>
          </View>
        )}
      </View>

      {/* Title */}
      <Text style={cardStyles.title}>{item.title}</Text>

      {/* Description */}
      {item.description ? (
        <Text style={cardStyles.description}>{item.description}</Text>
      ) : null}

      {/* Meta row */}
      <View style={cardStyles.metaRow}>
        <Text style={cardStyles.metaDate}>
          📅 {formatDate(item.created_at.slice(0, 10))}
        </Text>
        {item.due_date && (
          <Text style={[cardStyles.metaDue, overdue && cardStyles.metaDueOverdue]}>
            {overdue ? '⚠️ Overdue ' : '⏰ Due '}
            {formatDate(item.due_date)}
          </Text>
        )}
      </View>

      {/* Files */}
      {item.file_urls.length > 0 && (
        <View style={cardStyles.filesSection}>
          {/* Images as thumbnails */}
          {item.file_urls.filter(isImageUrl).length > 0 && (
            <View style={cardStyles.thumbnailRow}>
              {item.file_urls.filter(isImageUrl).map((url, idx) => (
                <TouchableOpacity
                  key={idx}
                  onPress={() => openFile(url)}
                  accessibilityRole="button"
                  accessibilityLabel={`View image ${idx + 1}`}
                >
                  <Image
                    source={{ uri: url }}
                    style={cardStyles.thumbnail}
                    resizeMode="cover"
                    accessibilityLabel={`Image ${idx + 1}`}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* PDFs and other files */}
          {item.file_urls.filter((u) => !isImageUrl(u)).map((url, idx) => (
            <TouchableOpacity
              key={idx}
              style={cardStyles.fileRow}
              onPress={() => openFile(url)}
              accessibilityRole="button"
              accessibilityLabel={`Open file ${fileBaseName(url, idx)}`}
            >
              <Text style={cardStyles.fileIcon}>📄</Text>
              <Text style={cardStyles.fileLink} numberOfLines={1}>
                {fileBaseName(url, idx)}
              </Text>
              <Text style={cardStyles.fileOpen}>Open ›</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Lightbox */}
      {lightboxUrl && (
        <ImageLightbox
          url={lightboxUrl}
          visible={!!lightboxUrl}
          onClose={() => setLightboxUrl(null)}
        />
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  typeBadge: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  noteBadge: { backgroundColor: '#DBEAFE' },
  assignmentBadge: { backgroundColor: '#FEF3C7' },
  typeText: { fontSize: 11, fontWeight: '700' },
  noteText: { color: '#1D4ED8' },
  assignmentText: { color: '#92400E' },
  newBadge: {
    backgroundColor: '#22C55E',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  newText: { fontSize: 9, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.5 },
  title: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  description: { fontSize: 13, color: '#6B7280', lineHeight: 19, marginBottom: 10 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 4 },
  metaDate: { fontSize: 12, color: '#9CA3AF' },
  metaDue: { fontSize: 12, fontWeight: '600', color: '#F59E0B' },
  metaDueOverdue: { color: '#EF4444' },
  filesSection: { marginTop: 12, gap: 8 },
  thumbnailRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  fileIcon: { fontSize: 16 },
  fileLink: { flex: 1, fontSize: 13, color: '#1D4ED8', fontWeight: '500' },
  fileOpen: { fontSize: 12, color: '#64748B', fontWeight: '600' },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ResourcesScreen() {
  const student    = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();

  // Use the active linked child if parent, else the logged-in student
  const activeStudent = linkedChildren.length > 0
    ? linkedChildren[activeChildIndex]
    : student;
  const studentClass   = (activeStudent as { class?: string; class_name?: string } | null)?.class
    ?? (activeStudent as { class?: string; class_name?: string } | null)?.class_name
    ?? null;
  const studentSection = (activeStudent as { section?: string } | null)?.section ?? null;

  const [subjects, setSubjects]     = useState<string[]>([]);
  const [activeSubject, setActiveSubject] = useState<string>('');
  const [resources, setResources]   = useState<ResourceItem[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subjectsLoading, setSubjectsLoading] = useState(true);

  // ── Fetch subjects that have at least one resource ────────────────────────
  const fetchSubjects = useCallback(async () => {
    if (!studentClass || !studentSection) {
      setSubjectsLoading(false);
      setLoading(false);
      return;
    }
    try {
      const res = await apiClient.get('/api/subject-resources/subjects', {
        params: { class: studentClass, section: studentSection },
      });
      const list: string[] = res.data.data ?? [];
      setSubjects(list);
      if (list.length > 0 && !activeSubject) {
        setActiveSubject(list[0]);
      }
    } catch (err) {
      console.warn('[Resources] subjects fetch error:', err);
    } finally {
      setSubjectsLoading(false);
    }
  }, [studentClass, studentSection, activeSubject]);

  // ── Fetch resources for the active subject ────────────────────────────────
  const fetchResources = useCallback(async (subject: string) => {
    if (!studentClass || !studentSection || !subject) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiClient.get('/api/subject-resources', {
        params: { class: studentClass, section: studentSection, subject, limit: 50 },
      });
      setResources(res.data.data ?? []);
    } catch (err) {
      console.warn('[Resources] resources fetch error:', err);
      setResources([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [studentClass, studentSection]);

  useEffect(() => { fetchSubjects(); }, [fetchSubjects]);
  useEffect(() => {
    if (activeSubject) fetchResources(activeSubject);
  }, [activeSubject, fetchResources]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchSubjects().then(() => {
      if (activeSubject) fetchResources(activeSubject);
    });
  }, [fetchSubjects, fetchResources, activeSubject]);

  function handleTabPress(subject: string) {
    if (subject === activeSubject) return;
    setActiveSubject(subject);
    setResources([]);
  }

  // ── Due-soon / overdue banner data ────────────────────────────────────────
  const assignments = resources.filter((r) => r.resource_type === 'assignment' && r.due_date);
  const overdueCount = assignments.filter((r) => isOverdue(r.due_date!)).length;
  const dueSoonCount = assignments.filter((r) => !isOverdue(r.due_date!) && isDueSoon(r.due_date!)).length;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!studentClass || !studentSection) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>📚</Text>
        <Text style={styles.emptyText}>No class assigned to your account.</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.container}>

        {/* Subject tabs */}
        {subjectsLoading ? (
          <View style={styles.tabBarSkeleton}>
            <ActivityIndicator size="small" color="#1D4ED8" />
          </View>
        ) : subjects.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyIcon}>📂</Text>
            <Text style={styles.emptyText}>No resources uploaded yet.</Text>
            <Text style={styles.emptySubText}>Your teacher hasn't uploaded any notes or assignments yet.</Text>
          </View>
        ) : (
          <>
            {/* Horizontal tab bar */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabBar}
              contentContainerStyle={styles.tabBarContent}
            >
              {subjects.map((sub) => {
                const active = sub === activeSubject;
                const palette = paletteFor(sub);
                return (
                  <TouchableOpacity
                    key={sub}
                    style={[
                      styles.tab,
                      active && { backgroundColor: palette.tab, borderColor: palette.tab },
                    ]}
                    onPress={() => handleTabPress(sub)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.tabText, active && styles.tabTextActive]}>
                      {sub}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Due/overdue banner */}
            {(overdueCount > 0 || dueSoonCount > 0) && (
              <View style={styles.banner}>
                {overdueCount > 0 && (
                  <Text style={styles.bannerOverdue}>
                    ⚠️ {overdueCount} assignment{overdueCount !== 1 ? 's' : ''} overdue
                  </Text>
                )}
                {dueSoonCount > 0 && (
                  <Text style={styles.bannerSoon}>
                    ⏰ {dueSoonCount} assignment{dueSoonCount !== 1 ? 's' : ''} due soon
                  </Text>
                )}
              </View>
            )}

            {/* Resources list */}
            {loading ? (
              <View style={styles.centered}>
                <ActivityIndicator size="large" color="#1D4ED8" />
              </View>
            ) : (
              <FlatList
                style={styles.list}
                contentContainerStyle={styles.listContent}
                data={resources}
                keyExtractor={(item) => item.id}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor="#1D4ED8"
                  />
                }
                renderItem={({ item }) => <ResourceCard item={item} />}
                ListEmptyComponent={
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyIcon}>📭</Text>
                    <Text style={styles.emptyText}>
                      No resources for {activeSubject} yet.
                    </Text>
                  </View>
                }
              />
            )}
          </>
        )}

      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  tabBarSkeleton: {
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  tabBar: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    maxHeight: 56,
    flexGrow: 0,
  },
  tabBarContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    alignItems: 'center',
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  },
  tabText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  tabTextActive: { color: '#FFFFFF' },
  banner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFFBEB',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
  },
  bannerOverdue: { fontSize: 12, fontWeight: '700', color: '#DC2626' },
  bannerSoon: { fontSize: 12, fontWeight: '700', color: '#D97706' },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 48 },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#374151', fontWeight: '600', textAlign: 'center' },
  emptySubText: { fontSize: 13, color: '#9CA3AF', marginTop: 6, textAlign: 'center' },
});
