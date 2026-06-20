import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, ScrollView,
  TouchableOpacity, StatusBar,
} from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SolvedExample {
  question: string;
  solution: string;
  steps: string[];
}

interface PracticeQuestion {
  question: string;
  answer: string;
}

interface PackSection {
  topic: string;
  explanation: string;
  key_concepts: string[];
  common_mistakes: string[];
  solved_examples: SolvedExample[];
  practice_questions: PracticeQuestion[];
}

interface PackContent {
  sections: PackSection[];
}

interface SubjectPack {
  id: string;
  subject: string;
  scheduled_month: string;
  weak_topics: string[] | null;
  pack_content: PackContent | null;
  student_profile_type: string | null;
  created_at: string;
}

interface LegacyPackDetail {
  id: string;
  subject: string;
  scheduled_month: string;
  weak_topics: string[] | null;
  pack_content: PackContent | null;
  created_at: string;
}

// ── Navigation types ──────────────────────────────────────────────────────────

interface RecoveryPackDetailScreenProps {
  navigation: StackNavigationProp<StudentStackParamList, 'RecoveryPackDetail'>;
  route: RouteProp<StudentStackParamList, 'RecoveryPackDetail'>;
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ section }: { section: PackSection }) {
  const [showAnswers, setShowAnswers] = useState<Set<number>>(new Set());

  function toggleAnswer(idx: number) {
    setShowAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  return (
    <View style={styles.sectionCard}>
      {/* Topic title */}
      <Text style={styles.sectionTopic}>{section.topic}</Text>

      {/* Explanation */}
      <Text style={styles.explanationText}>{section.explanation}</Text>

      {/* Key concepts */}
      {section.key_concepts.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>📌 Key Concepts</Text>
          {section.key_concepts.map((c, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Common mistakes */}
      {section.common_mistakes.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>⚠️ Common Mistakes</Text>
          {section.common_mistakes.map((m, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={[styles.bullet, styles.redBullet]}>•</Text>
              <Text style={[styles.bulletText, styles.redText]}>{m}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Solved examples */}
      {section.solved_examples.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>✏️ Solved Example</Text>
          {section.solved_examples.map((ex, i) => (
            <View key={i} style={styles.exampleCard}>
              <Text style={styles.exampleQ}>{ex.question}</Text>
              {ex.steps.length > 0 && (
                <View style={styles.stepsBlock}>
                  {ex.steps.map((step, si) => (
                    <Text key={si} style={styles.stepText}>Step {si + 1}: {step}</Text>
                  ))}
                </View>
              )}
              <View style={styles.solutionRow}>
                <Text style={styles.solutionLabel}>Answer: </Text>
                <Text style={styles.solutionText}>{ex.solution}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Practice questions */}
      {section.practice_questions.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>🎯 Practice Questions</Text>
          {section.practice_questions.map((pq, i) => (
            <View key={i} style={styles.practiceCard}>
              <Text style={styles.practiceQ}>Q{i + 1}. {pq.question}</Text>
              <TouchableOpacity
                onPress={() => toggleAnswer(i)}
                style={styles.showAnswerBtn}
                accessibilityRole="button"
                accessibilityLabel={showAnswers.has(i) ? 'Hide answer' : 'Show answer'}
              >
                <Text style={styles.showAnswerText}>
                  {showAnswers.has(i) ? '▲ Hide Answer' : '▼ Show Answer'}
                </Text>
              </TouchableOpacity>
              {showAnswers.has(i) && (
                <View style={styles.answerBox}>
                  <Text style={styles.answerText}>{pq.answer}</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function RecoveryPackDetailScreen({ route, navigation }: RecoveryPackDetailScreenProps) {
  const { packId, isCycle } = route.params;

  const [subjectPacks, setSubjectPacks] = useState<SubjectPack[]>([]);
  const [legacyPack, setLegacyPack] = useState<LegacyPackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSubjectIndex, setActiveSubjectIndex] = useState(0);

  const loadPack = useCallback(async () => {
    setError(null);
    try {
      if (isCycle) {
        const res = await apiClient.get(`/api/student-recovery/packs/by-cycle/${packId}`);
        setSubjectPacks((res.data?.data ?? []) as SubjectPack[]);
      } else {
        const res = await apiClient.get(`/api/student-recovery/packs/${packId}`);
        setLegacyPack(res.data?.data as LegacyPackDetail);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load pack');
    } finally {
      setLoading(false);
    }
  }, [packId, isCycle]);

  useEffect(() => { loadPack(); }, [loadPack]);

  // Determine subjects and active pack content
  const subjects = isCycle
    ? subjectPacks.map((p) => p.subject)
    : legacyPack ? [legacyPack.subject] : [];

  const activePack: { pack_content: PackContent | null } | null = isCycle
    ? (subjectPacks[activeSubjectIndex] ?? null)
    : legacyPack;

  const sections = activePack?.pack_content?.sections ?? [];

  useEffect(() => {
    if (subjects.length > 0) {
      navigation.setOptions({ headerTitle: isCycle ? 'Recovery Pack' : `${subjects[0]} Pack` });
    }
  }, [subjects, isCycle, navigation]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (error || (!isCycle && !legacyPack) || (isCycle && subjectPacks.length === 0)) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>⚠️ {error ?? 'Pack not found'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); loadPack(); }} accessibilityRole="button">
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Subject tabs */}
      {subjects.length > 1 && (
        <View style={styles.tabBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabContent}>
            {subjects.map((subj, idx) => (
              <TouchableOpacity
                key={subj}
                style={[styles.tab, activeSubjectIndex === idx && styles.tabActive]}
                onPress={() => setActiveSubjectIndex(idx)}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeSubjectIndex === idx }}
              >
                <Text style={[styles.tabText, activeSubjectIndex === idx && styles.tabTextActive]}>{subj}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {sections.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No content available for this subject</Text>
          </View>
        ) : (
          sections.map((section, i) => (
            <SectionCard key={`${section.topic}-${i}`} section={section} />
          ))
        )}
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 16, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#F9FAFB' },
  errorText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center', marginBottom: 16 },
  emptyText: { fontSize: 14, color: '#9CA3AF', textAlign: 'center' },
  retryButton: { backgroundColor: '#1D4ED8', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },

  // Tabs
  tabBar: { backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  tabContent: { paddingHorizontal: 12, paddingVertical: 4, gap: 4, flexDirection: 'row' },
  tab: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  tabText: { fontSize: 14, fontWeight: '600', color: '#6B7280' },
  tabTextActive: { color: '#1D4ED8' },

  // Section card
  sectionCard: {
    backgroundColor: '#FFFFFF', borderRadius: 14, marginBottom: 16, padding: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 5, elevation: 2,
  },
  sectionTopic: { fontSize: 18, fontWeight: '800', color: '#111827', marginBottom: 10 },
  explanationText: { fontSize: 14, color: '#374151', lineHeight: 22, marginBottom: 14 },

  // Blocks
  block: { marginBottom: 14 },
  blockTitle: { fontSize: 13, fontWeight: '700', color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  bulletRow: { flexDirection: 'row', marginBottom: 5 },
  bullet: { fontSize: 14, color: '#1D4ED8', marginRight: 8, lineHeight: 21 },
  redBullet: { color: '#EF4444' },
  bulletText: { fontSize: 13, color: '#4B5563', flex: 1, lineHeight: 21 },
  redText: { color: '#DC2626' },

  // Solved example
  exampleCard: { backgroundColor: '#F0FDF4', borderRadius: 10, padding: 14, borderLeftWidth: 3, borderLeftColor: '#22C55E' },
  exampleQ: { fontSize: 14, fontWeight: '600', color: '#111827', marginBottom: 10 },
  stepsBlock: { marginBottom: 8 },
  stepText: { fontSize: 13, color: '#374151', lineHeight: 20, marginBottom: 4 },
  solutionRow: { flexDirection: 'row', flexWrap: 'wrap' },
  solutionLabel: { fontSize: 13, fontWeight: '700', color: '#15803D' },
  solutionText: { fontSize: 13, color: '#15803D', flex: 1 },

  // Practice questions
  practiceCard: { backgroundColor: '#EFF6FF', borderRadius: 10, padding: 14, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#3B82F6' },
  practiceQ: { fontSize: 13, color: '#1E3A8A', lineHeight: 20, marginBottom: 8 },
  showAnswerBtn: { alignSelf: 'flex-start' },
  showAnswerText: { fontSize: 12, fontWeight: '600', color: '#1D4ED8' },
  answerBox: { marginTop: 8, backgroundColor: '#DBEAFE', borderRadius: 8, padding: 10 },
  answerText: { fontSize: 13, color: '#1E3A8A', lineHeight: 20 },
});
