import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
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

interface PackDetail {
  id: string;
  subject: string;
  scheduled_month: string;
  weak_topics: string[] | null;
  pack_content: PackContent | null;
  test_available: boolean;
  test_id: string | null;
  test_total_questions: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  const date = new Date(parseInt(y), parseInt(m) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Collapsible "Show Answer" ─────────────────────────────────────────────────

function CollapsibleAnswer({ answer }: { answer: string }) {
  const [visible, setVisible] = useState(false);

  return (
    <View style={answerStyles.wrap}>
      <TouchableOpacity
        style={[answerStyles.toggle, visible && answerStyles.toggleOpen]}
        onPress={() => setVisible((v) => !v)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide answer' : 'Show answer'}
      >
        <Text style={[answerStyles.toggleText, visible && answerStyles.toggleTextOpen]}>
          {visible ? '▲ Hide Answer' : '▼ Show Answer'}
        </Text>
      </TouchableOpacity>
      {visible && (
        <View style={answerStyles.answerBox}>
          <Text style={answerStyles.answerText}>{answer}</Text>
        </View>
      )}
    </View>
  );
}

const answerStyles = StyleSheet.create({
  wrap: { marginTop: 8 },
  toggle: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  toggleOpen: { backgroundColor: '#DBEAFE' },
  toggleText: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  toggleTextOpen: { color: '#1D4ED8' },
  answerBox: {
    marginTop: 6,
    backgroundColor: '#F0FDF4',
    borderRadius: 8,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
  },
  answerText: { fontSize: 13, color: '#166534', lineHeight: 20 },
});

// ── Section renderer ──────────────────────────────────────────────────────────

function PackSectionView({ section }: { section: PackSection }) {
  return (
    <View style={sectionStyles.wrap}>
      {/* Topic header */}
      <Text style={sectionStyles.topicTitle}>{section.topic}</Text>

      {/* Explanation */}
      <View style={sectionStyles.block}>
        <Text style={sectionStyles.blockLabel}>📖 Explanation</Text>
        <Text style={sectionStyles.explanationText}>{section.explanation}</Text>
      </View>

      {/* Key Concepts */}
      {section.key_concepts?.length > 0 && (
        <View style={sectionStyles.block}>
          <Text style={sectionStyles.blockLabel}>🔑 Key Concepts</Text>
          {section.key_concepts.map((concept, i) => (
            <View key={i} style={sectionStyles.bulletRow}>
              <Text style={sectionStyles.bullet}>•</Text>
              <Text style={sectionStyles.bulletText}>{concept}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Common Mistakes */}
      {section.common_mistakes?.length > 0 && (
        <View style={sectionStyles.block}>
          <Text style={sectionStyles.blockLabel}>⚠️ Common Mistakes</Text>
          {section.common_mistakes.map((mistake, i) => (
            <View key={i} style={sectionStyles.bulletRow}>
              <Text style={[sectionStyles.bullet, sectionStyles.bulletAmber]}>•</Text>
              <Text style={sectionStyles.bulletText}>{mistake}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Solved Examples */}
      {section.solved_examples?.length > 0 && (
        <View style={sectionStyles.block}>
          <Text style={sectionStyles.blockLabel}>✅ Solved Example{section.solved_examples.length > 1 ? 's' : ''}</Text>
          {section.solved_examples.map((ex, i) => (
            <View key={i} style={sectionStyles.exampleBox}>
              <Text style={sectionStyles.exampleQuestion}>Q: {ex.question}</Text>
              {ex.steps?.length > 0 && (
                <View style={sectionStyles.stepsList}>
                  {ex.steps.map((step, si) => (
                    <View key={si} style={sectionStyles.stepRow}>
                      <Text style={sectionStyles.stepNum}>{si + 1}.</Text>
                      <Text style={sectionStyles.stepText}>{step}</Text>
                    </View>
                  ))}
                </View>
              )}
              {ex.solution && ex.steps?.length === 0 && (
                <Text style={sectionStyles.solutionText}>{ex.solution}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {/* Practice Questions */}
      {section.practice_questions?.length > 0 && (
        <View style={sectionStyles.block}>
          <Text style={sectionStyles.blockLabel}>📝 Practice Questions</Text>
          {section.practice_questions.map((pq, i) => (
            <View key={i} style={sectionStyles.practiceBox}>
              <Text style={sectionStyles.practiceQuestion}>
                {i + 1}. {pq.question}
              </Text>
              <CollapsibleAnswer answer={pq.answer} />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: {
    marginBottom: 20,
  },
  topicTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1D4ED8',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 2,
    borderBottomColor: '#DBEAFE',
  },
  block: { marginBottom: 14 },
  blockLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 8,
  },
  explanationText: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 22,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#93C5FD',
  },
  bulletRow: { flexDirection: 'row', marginBottom: 5 },
  bullet: { fontSize: 14, color: '#1D4ED8', marginRight: 8, lineHeight: 22 },
  bulletAmber: { color: '#D97706' },
  bulletText: { flex: 1, fontSize: 14, color: '#374151', lineHeight: 22 },

  exampleBox: {
    backgroundColor: '#F0FDF4',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
  },
  exampleQuestion: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
    lineHeight: 20,
  },
  stepsList: { marginTop: 4 },
  stepRow: { flexDirection: 'row', marginBottom: 4 },
  stepNum: { fontSize: 13, fontWeight: '700', color: '#166534', marginRight: 6, minWidth: 18 },
  stepText: { flex: 1, fontSize: 13, color: '#166534', lineHeight: 20 },
  solutionText: { fontSize: 13, color: '#166534', lineHeight: 20 },

  practiceBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  practiceQuestion: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 21,
  },
});

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  route: { params: { packId: string } };
}

export default function RecoveryPackDetailScreen({ route }: Props) {
  const { packId } = route.params;
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchPack = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.get(`/api/student-recovery/packs/${packId}`);
      setPack(res.data?.data as PackDetail);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load recovery pack');
    } finally {
      setLoading(false);
    }
  }, [packId]);

  useEffect(() => { fetchPack(); }, [fetchPack]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (error || !pack) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>⚠️ {error ?? 'Pack not found'}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); fetchPack(); }}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const sections = pack.pack_content?.sections ?? [];
  const topics = pack.weak_topics ?? sections.map((s) => s.topic);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* Back link */}
        <TouchableOpacity
          style={styles.backLink}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to Recovery Packs"
        >
          <Text style={styles.backLinkText}>← Back to Recovery Packs</Text>
        </TouchableOpacity>

        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <Text style={styles.subjectTitle}>{pack.subject}</Text>
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>Recovery Pack</Text>
            </View>
          </View>
          <Text style={styles.monthSubtitle}>{formatMonth(pack.scheduled_month)}</Text>

          {/* Topics covered */}
          {topics.length > 0 && (
            <View style={styles.topicsSummary}>
              <Text style={styles.topicsLabel}>Topics covered:</Text>
              <Text style={styles.topicsList}>{topics.join(' · ')}</Text>
            </View>
          )}
        </View>

        {/* Sections */}
        {sections.length > 0 ? (
          sections.map((section, i) => (
            <React.Fragment key={section.topic + i}>
              <PackSectionView section={section} />
              {i < sections.length - 1 && <View style={styles.divider} />}
            </React.Fragment>
          ))
        ) : (
          <View style={styles.emptyContent}>
            <Text style={styles.emptyText}>Pack content is not available yet.</Text>
          </View>
        )}

        {/* Recovery test banner */}
        {pack.test_available && pack.test_id && (
          <View style={styles.testBanner}>
            <Text style={styles.testBannerTitle}>
              🎯 Your Recovery Test for {pack.subject} is now available!
            </Text>
            {pack.test_total_questions != null && (
              <Text style={styles.testBannerSub}>
                {pack.test_total_questions} questions · Based on the topics above
              </Text>
            )}
            <TouchableOpacity
              style={styles.testBannerBtn}
              onPress={() =>
                navigation.navigate('MonthlyRecoveryTestAttempt', { testId: pack.test_id! })
              }
              accessibilityRole="button"
              accessibilityLabel="Take recovery test"
            >
              <Text style={styles.testBannerBtnText}>Take Test →</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },

  backLink: { marginBottom: 14 },
  backLinkText: { fontSize: 14, fontWeight: '600', color: '#1D4ED8' },

  headerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 18,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  subjectTitle: { fontSize: 20, fontWeight: '800', color: '#111827' },
  headerBadge: {
    backgroundColor: '#DBEAFE',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  headerBadgeText: { fontSize: 12, fontWeight: '700', color: '#1D4ED8' },
  monthSubtitle: { fontSize: 14, color: '#6B7280', marginBottom: 10 },
  topicsSummary: { marginTop: 6 },
  topicsLabel: { fontSize: 12, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5 },
  topicsList: { fontSize: 13, color: '#374151', lineHeight: 20, marginTop: 4 },

  divider: { height: 1, backgroundColor: '#E5E7EB', marginVertical: 20 },

  emptyContent: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { fontSize: 14, color: '#9CA3AF' },

  testBanner: {
    backgroundColor: '#1D4ED8',
    borderRadius: 14,
    padding: 18,
    marginTop: 20,
    alignItems: 'flex-start',
  },
  testBannerTitle: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', lineHeight: 22 },
  testBannerSub: { fontSize: 13, color: '#BFDBFE', marginTop: 4, marginBottom: 14 },
  testBannerBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  testBannerBtnText: { fontSize: 14, fontWeight: '700', color: '#1D4ED8' },

  errorText: { fontSize: 15, color: '#DC2626', textAlign: 'center', marginBottom: 12 },
  retryBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
