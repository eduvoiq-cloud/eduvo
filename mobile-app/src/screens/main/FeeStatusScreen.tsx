import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeeRecord {
  fee_paid: boolean;
  total_fee_amount: number | null;
  amount_paid: number | null;
  payment_status: 'paid' | 'partial' | 'unpaid';
  term: string | null;
  academic_year: string | null;
  notes: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return '—';
  return `₹${amount.toLocaleString('en-IN')}`;
}

function statusColor(status: FeeRecord['payment_status']): string {
  switch (status) {
    case 'paid':    return '#15803D';
    case 'partial': return '#B45309';
    case 'unpaid':  return '#DC2626';
    default:        return '#6B7280';
  }
}

function statusBg(status: FeeRecord['payment_status']): string {
  switch (status) {
    case 'paid':    return '#DCFCE7';
    case 'partial': return '#FEF3C7';
    case 'unpaid':  return '#FEF2F2';
    default:        return '#F3F4F6';
  }
}

function statusLabel(status: FeeRecord['payment_status']): string {
  switch (status) {
    case 'paid':    return '✓ Paid';
    case 'partial': return '⏳ Partial';
    case 'unpaid':  return '✗ Unpaid';
    default:        return status;
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FeeStatusScreen() {
  const student = useAuthStore((s) => s.student);
  const [feeRecord, setFeeRecord] = useState<FeeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFeeStatus = useCallback(async () => {
    if (!student?.id) {
      setError('Student profile not loaded.');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      setError(null);
      const response = await apiClient.get(`/api/fees/my-status`);
      const data = response.data.data;
      setFeeRecord(data ?? null);
    } catch (err: unknown) {
      console.warn('[FeeStatus] fetch error:', err);
      setError('Unable to load fee information. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [student?.id]);

  useEffect(() => { fetchFeeStatus(); }, [fetchFeeStatus]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchFeeStatus();
  }, [fetchFeeStatus]);

  const remaining =
    feeRecord?.total_fee_amount != null && feeRecord?.amount_paid != null
      ? Math.max(0, feeRecord.total_fee_amount - feeRecord.amount_paid)
      : null;

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
      >
        <Text style={styles.title}>Fee Status</Text>

        {loading ? (
          <ActivityIndicator size="large" color="#1D4ED8" style={{ marginTop: 40 }} />
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : feeRecord === null ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>💰</Text>
            <Text style={styles.emptyTitle}>No Fee Record Found</Text>
            <Text style={styles.emptyDesc}>
              Your school has not yet set up a fee record for you. Please contact the school office.
            </Text>
          </View>
        ) : (
          <>
            {/* Status badge */}
            <View style={[styles.statusCard, { backgroundColor: statusBg(feeRecord.payment_status) }]}>
              <Text style={[styles.statusBadge, { color: statusColor(feeRecord.payment_status) }]}>
                {statusLabel(feeRecord.payment_status)}
              </Text>
              {feeRecord.term ? (
                <Text style={[styles.statusMeta, { color: statusColor(feeRecord.payment_status) }]}>
                  {feeRecord.term}{feeRecord.academic_year ? ` · ${feeRecord.academic_year}` : ''}
                </Text>
              ) : null}
            </View>

            {/* Fee breakdown */}
            <View style={styles.breakdownCard}>
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>Total Fee</Text>
                <Text style={styles.breakdownValue}>
                  {formatCurrency(feeRecord.total_fee_amount)}
                </Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>Amount Paid</Text>
                <Text style={[styles.breakdownValue, { color: '#15803D' }]}>
                  {formatCurrency(feeRecord.amount_paid)}
                </Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.breakdownRow}>
                <Text style={[styles.breakdownLabel, { fontWeight: '700', color: '#111827' }]}>
                  Remaining
                </Text>
                <Text
                  style={[
                    styles.breakdownValue,
                    {
                      color: remaining === 0 ? '#15803D' : '#DC2626',
                      fontWeight: '700',
                      fontSize: 18,
                    },
                  ]}
                >
                  {formatCurrency(remaining)}
                </Text>
              </View>
            </View>

            {/* Progress bar */}
            {feeRecord.total_fee_amount != null && feeRecord.total_fee_amount > 0 && (
              <View style={styles.progressContainer}>
                <View style={styles.progressBar}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.min(100, ((feeRecord.amount_paid ?? 0) / feeRecord.total_fee_amount) * 100)}%`,
                        backgroundColor:
                          feeRecord.payment_status === 'paid' ? '#22C55E' :
                          feeRecord.payment_status === 'partial' ? '#F59E0B' : '#EF4444',
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressText}>
                  {Math.round(((feeRecord.amount_paid ?? 0) / feeRecord.total_fee_amount) * 100)}% paid
                </Text>
              </View>
            )}

            {/* Notes */}
            {feeRecord.notes ? (
              <View style={styles.notesBox}>
                <Text style={styles.notesLabel}>Note from School</Text>
                <Text style={styles.notesText}>{feeRecord.notes}</Text>
              </View>
            ) : null}

            <Text style={styles.hint}>
              Pull down to refresh · Contact your school office for payment details.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 20 },
  errorBox: { alignItems: 'center', marginTop: 40 },
  errorIcon: { fontSize: 36, marginBottom: 12 },
  errorText: { fontSize: 14, color: '#EF4444', textAlign: 'center' },
  emptyState: { alignItems: 'center', marginTop: 48, paddingHorizontal: 20 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#374151', marginBottom: 8 },
  emptyDesc: { fontSize: 14, color: '#9CA3AF', textAlign: 'center', lineHeight: 21 },
  statusCard: {
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
    alignItems: 'center',
  },
  statusBadge: { fontSize: 22, fontWeight: '800', marginBottom: 4 },
  statusMeta: { fontSize: 13, fontWeight: '500' },
  breakdownCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  breakdownLabel: { fontSize: 15, color: '#374151', fontWeight: '500' },
  breakdownValue: { fontSize: 16, color: '#111827', fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#F3F4F6' },
  progressContainer: { marginBottom: 20 },
  progressBar: {
    height: 10,
    backgroundColor: '#E5E7EB',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: { height: '100%', borderRadius: 5 },
  progressText: { fontSize: 12, color: '#6B7280', textAlign: 'right' },
  notesBox: {
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
    marginBottom: 16,
  },
  notesLabel: { fontSize: 12, fontWeight: '700', color: '#B45309', marginBottom: 4 },
  notesText: { fontSize: 14, color: '#374151' },
  hint: { fontSize: 12, color: '#D1D5DB', textAlign: 'center', marginTop: 8 },
});
