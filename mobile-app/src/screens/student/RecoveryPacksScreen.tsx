import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CyclePack {
  id: string;         // cycle_id
  type: 'cycle';
  subjects: string[];
  subject_count: number;
  scheduled_month: string;
  created_at: string;
}

interface LegacyPack {
  id: string;
  type: 'legacy';
  subject: string;
  subjects: string[];
  subject_count: number;
  scheduled_month: string;
  weak_topics: string[] | null;
  created_at: string;
}

type PackCard = CyclePack | LegacyPack;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Pack card component ───────────────────────────────────────────────────────

function PackCardView({ pack, onPress }: { pack: PackCard; onPress: () => void }) {
  const isCycle = pack.type === 'cycle';
  const topics = !isCycle && pack.type === 'legacy' ? (pack.weak_topics ?? []) : [];

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`Recovery pack — ${isCycle ? pack.subjects.join(', ') : (pack as LegacyPack).subject}. Tap to open.`}
    >
      {/* Header */}
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.subjectText}>
            {isCycle
              ? pack.subjects.length === 1 ? pack.subjects[0] : `${pack.subjects[0]} + ${pack.subject_count - 1} more`
              : (pack as LegacyPack).subject}
          </Text>
          <Text style={styles.monthText}>{formatMonth(pack.scheduled_month)}</Text>
        </View>
        <View style={styles.packIconWrap}>
          <Text style={styles.packIcon}>📘</Text>
        </View>
      </View>

      {/* Subject count badge for multi-subject cycles */}
      {isCycle && pack.subject_count > 1 && (
        <View style={styles.badgeRow}>
          <View style={styles.subjectBadge}>
            <Text style={styles.subjectBadgeText}>{pack.subject_count} subjects</Text>
          </View>
          {pack.subjects.slice(0, 3).map((s) => (
            <View key={s} style={styles.topicTag}>
              <Text style={styles.topicTagText} numberOfLines={1}>{s}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Weak topic tags for legacy packs */}
      {!isCycle && topics.length > 0 && (
        <View style={styles.topicsRow}>
          {topics.slice(0, 4).map((topic) => (
            <View key={topic} style={styles.topicTag}>
              <Text style={styles.topicTagText} numberOfLines={1}>{topic}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.ctaRow}>
        <Text style={styles.ctaText}>Open Pack →</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryPacksScreen() {
  const [packs, setPacks] = useState<PackCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchPacks = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.get('/api/student-recovery/packs');
      setPacks((res.data?.data ?? []) as PackCard[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load recovery packs');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchPacks(); }, [fetchPacks]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchPacks(); }, [fetchPacks]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      {/* Error banner — shown above list when a refresh fails after successful load */}
      {error && packs.length > 0 && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>⚠️ {error} — showing cached data</Text>
        </View>
      )}
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={packs}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.title}>Recovery Packs</Text>
            <Text style={styles.subtitle}>Personalised study packs based on your weak topics</Text>
          </View>
        }
        renderItem={({ item }) => (
          <PackCardView
            pack={item}
            onPress={() => {
              if (item.type === 'cycle') {
                navigation.navigate('RecoveryPackDetail', { packId: item.id, isCycle: true });
              } else {
                navigation.navigate('RecoveryPackDetail', { packId: item.id, isCycle: false });
              }
            }}
          />
        )}
        ListEmptyComponent={
          error ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>⚠️ {error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); fetchPacks(); }} accessibilityRole="button">
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📘</Text>
              <Text style={styles.emptyText}>No recovery packs yet.</Text>
              <Text style={styles.emptySubtext}>
                Packs are generated after your teacher starts a recovery cycle.
              </Text>
            </View>
          )
        }
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
  listHeader: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6B7280' },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 14, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 5, elevation: 2, overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', padding: 16, paddingBottom: 10,
  },
  cardLeft: { flex: 1 },
  subjectText: { fontSize: 17, fontWeight: '700', color: '#111827' },
  monthText: { fontSize: 13, color: '#6B7280', marginTop: 3 },
  packIconWrap: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: '#DBEAFE',
    justifyContent: 'center', alignItems: 'center',
  },
  packIcon: { fontSize: 22 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 10 },
  subjectBadge: {
    backgroundColor: '#7C3AED', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  subjectBadgeText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  topicsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 12 },
  topicTag: {
    backgroundColor: '#EFF6FF', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: '#BFDBFE',
  },
  topicTagText: { fontSize: 11, fontWeight: '600', color: '#1D4ED8' },
  ctaRow: { borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingVertical: 10, paddingHorizontal: 16, alignItems: 'flex-end' },
  ctaText: { fontSize: 13, fontWeight: '700', color: '#1D4ED8' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  emptySubtext: { fontSize: 13, color: '#D1D5DB', marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },
  retryButton: { marginTop: 16, backgroundColor: '#1D4ED8', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  errorBanner: { backgroundColor: '#FEE2E2', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#FECACA' },
  errorBannerText: { color: '#DC2626', fontSize: 13, fontWeight: '500', textAlign: 'center' },
});
