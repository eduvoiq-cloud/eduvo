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
  real_world_application?: string;
  key_concepts: string[];
  common_mistakes: string[];
  solved_examples: SolvedExample[];
  practice_questions: PracticeQuestion[];
}

interface PackContent {
  sections: PackSection[];
}

interface WeakChapter {
  chapter: string;
  score_pct: number;
  wrong_count: number;
}

interface InsightCard {
  tests_attempted: number;
  overall_score_pct: number;
  weak_chapters: WeakChapter[];
  sample_wrong_questions: Array<{ question_text: string; chapter: string }>;
}

interface SubjectPack {
  id: string;
  subject: string;
  scheduled_month: string;
  weak_topics: string[] | null;
  pack_content: PackContent | null;
  student_profile_type: string | null;
  insight_card: InsightCard | null;
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

// ── Insight Card component ────────────────────────────────────────────────────

function InsightCardView({ insight }: { insight: InsightCard }) {
  const [expanded, setExpanded] = useState(false);

  const scoreColor = insight.overall_score_pct >= 75
    ? '#16A34A'
    : insight.overall_score_pct >= 50
    ? '#D97706'
    : '#DC2626';

  return (
    <View style={styles.insightCard}>
      {/* Header row */}
      <View style={styles.insightHeader}>
        <View style={styles.insightHeaderLeft}>
          <Text style={styles.insightIcon}>📊</Text>
          <View>
            <Text style={styles.insightTitle}>Your Recent Performance</Text>
            <Text style={styles.insightSubtitle}>
              {insight.tests_attempted} test{insight.tests_attempted !== 1 ? 's' : ''} attempted in last 90 days
            </Text>
          </View>
        </View>
        <View style={[styles.insightScoreBadge, { backgroundColor: scoreColor + '20', borderColor: scoreColor + '60' }]}>
          <Text style={[styles.insightScoreText, { color: scoreColor }]}>
            {insight.overall_score_pct}%
          </Text>
        </View>
      </View>

      {/* This pack was built to fix your weak areas */}
      <View style={styles.insightReasonRow}>
        <Text style={styles.insightReasonText}>
          ⬆️ This pack was built to fix your weak areas below
        </Text>
      </View>

      {/* Weak chapters */}
      {insight.weak_chapters.length > 0 && (
        <View style={styles.insightChapters}>
          {insight.weak_chapters.map((ch, i) => (
            <View key={i} style={styles.insightChapterRow}>
              <View style={styles.insightChapterLeft}>
                <Text style={styles.insightChapterName} numberOfLines={1}>{ch.chapter}</Text>
                <Text style={styles.insightChapterMeta}>
                  {ch.wrong_count} question{ch.wrong_count !== 1 ? 's' : ''} wrong
                </Text>
              </View>
              <View style={styles.insightChapterBarWrap}>
                <View style={styles.insightChapterBarBg}>
                  <View
                    style={[
                      styles.insightChapterBarFill,
                      {
                        width: `${ch.score_pct}%` as unknown as number,
                        backgroundColor: ch.score_pct < 50 ? '#EF4444' : ch.score_pct < 75 ? '#F97316' : '#22C55E',
                      },
                    ]}
                  />
                </View>
                <Text style={styles.insightChapterPct}>{ch.score_pct}%</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Sample wrong questions — collapsible */}
      {insight.sample_wrong_questions.length > 0 && (
        <>
          <TouchableOpacity
            style={styles.insightExpandBtn}
            onPress={() => setExpanded((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide questions you got wrong' : 'Show questions you got wrong'}
          >
            <Text style={styles.insightExpandText}>
              {expanded ? '▲ Hide questions you got wrong' : `▼ See ${insight.sample_wrong_questions.length} question${insight.sample_wrong_questions.length !== 1 ? 's' : ''} you got wrong`}
            </Text>
          </TouchableOpacity>

          {expanded && (
            <View style={styles.insightWrongList}>
              {insight.sample_wrong_questions.map((q, i) => (
                <View key={i} style={styles.insightWrongItem}>
                  <Text style={styles.insightWrongBullet}>✗</Text>
                  <Text style={styles.insightWrongText} numberOfLines={3}>{q.question_text}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
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

      {/* Real-world application */}
      {!!section.real_world_application && (
        <View style={styles.realWorldBlock}>
          <View style={styles.realWorldHeader}>
            <Text style={styles.realWorldIcon}>🌍</Text>
            <Text style={styles.realWorldTitle}>Real World</Text>
          </View>
          <Text style={styles.realWorldText}>{section.real_world_application}</Text>
        </View>
      )}

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

  const activePack: { pack_content: PackContent | null; insight_card?: InsightCard | null } | null = isCycle
    ? (subjectPacks[activeSubjectIndex] ?? null)
    : legacyPack;

  const sections = activePack?.pack_content?.sections ?? [];
  const insightCard = (activePack as SubjectPack | null)?.insight_card ?? null;

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
          <>
            {/* Insight card — only shown when student has real test history for this subject */}
            {!!insightCard && <InsightCardView insight={insightCard} />}

            {sections.map((section, i) => (
              <SectionCard key={`${section.topic}-${i}`} section={section} />
            ))}
          </>
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

  // Real-world application
  realWorldBlock: {
    backgroundColor: '#FFF7ED',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderLeftWidth: 4,
    borderLeftColor: '#F97316',
  },
  realWorldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  realWorldIcon: { fontSize: 16, marginRight: 6 },
  realWorldTitle: { fontSize: 12, fontWeight: '800', color: '#EA580C', textTransform: 'uppercase', letterSpacing: 0.5 },
  realWorldText: { fontSize: 13, color: '#7C2D12', lineHeight: 21 },

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

  // Insight card
  insightCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 18,
    borderWidth: 1.5,
    borderColor: '#E0E7FF',
    overflow: 'hidden',
    shadowColor: '#4F46E5',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    backgroundColor: '#EEF2FF',
  },
  insightHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  insightIcon: { fontSize: 22, marginRight: 10 },
  insightTitle: { fontSize: 14, fontWeight: '700', color: '#1E1B4B' },
  insightSubtitle: { fontSize: 11, color: '#6366F1', marginTop: 1 },
  insightScoreBadge: {
    borderRadius: 20,
    borderWidth: 1.5,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginLeft: 8,
  },
  insightScoreText: { fontSize: 15, fontWeight: '800' },
  insightReasonRow: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#F5F3FF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E7FF',
  },
  insightReasonText: { fontSize: 12, fontWeight: '600', color: '#4338CA' },
  insightChapters: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  insightChapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  insightChapterLeft: { flex: 1 },
  insightChapterName: { fontSize: 13, fontWeight: '600', color: '#1F2937' },
  insightChapterMeta: { fontSize: 11, color: '#9CA3AF', marginTop: 1 },
  insightChapterBarWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  insightChapterBarBg: {
    flex: 1,
    height: 7,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  insightChapterBarFill: { height: 7, borderRadius: 4 },
  insightChapterPct: { fontSize: 11, fontWeight: '700', color: '#374151', minWidth: 30, textAlign: 'right' },
  insightExpandBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E0E7FF',
  },
  insightExpandText: { fontSize: 12, fontWeight: '600', color: '#6366F1' },
  insightWrongList: { paddingHorizontal: 14, paddingBottom: 12 },
  insightWrongItem: { flexDirection: 'row', marginBottom: 8, alignItems: 'flex-start' },
  insightWrongBullet: { fontSize: 13, color: '#EF4444', marginRight: 8, lineHeight: 20, fontWeight: '700' },
  insightWrongText: { fontSize: 12, color: '#374151', flex: 1, lineHeight: 19 },
});
