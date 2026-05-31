import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type RecipientType = 'class_teacher' | 'school_admin';

interface Complaint {
  id: string;
  subject: string | null;
  message: string;
  recipient_type: RecipientType;
  status: 'pending' | 'reviewed' | 'resolved';
  response: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: Complaint['status']): string {
  switch (status) {
    case 'pending':  return '#F59E0B';
    case 'reviewed': return '#3B82F6';
    case 'resolved': return '#22C55E';
    default:         return '#9CA3AF';
  }
}

function statusBg(status: Complaint['status']): string {
  switch (status) {
    case 'pending':  return '#FEF3C7';
    case 'reviewed': return '#DBEAFE';
    case 'resolved': return '#DCFCE7';
    default:         return '#F3F4F6';
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Complaint form modal ──────────────────────────────────────────────────────

function ComplaintModal({
  visible,
  recipientType,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  recipientType: RecipientType;
  onClose: () => void;
  onSubmit: (subject: string, message: string, recipientType: RecipientType) => Promise<void>;
}) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const title =
    recipientType === 'class_teacher' ? 'Complain to Class Teacher' : 'Complain to School Admin';

  const handleSubmit = async () => {
    if (!message.trim()) {
      Alert.alert('Required', 'Please enter your complaint message.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(subject.trim(), message.trim(), recipientType);
      setSubject('');
      setMessage('');
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        style={modalStyles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={modalStyles.sheet}>
          {/* Header */}
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{title}</Text>
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={modalStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Subject */}
          <Text style={modalStyles.label}>Subject (optional)</Text>
          <TextInput
            style={modalStyles.input}
            placeholder="Brief subject..."
            placeholderTextColor="#9CA3AF"
            value={subject}
            onChangeText={setSubject}
            maxLength={200}
            editable={!submitting}
            accessibilityLabel="Complaint subject"
          />
          <Text style={modalStyles.charCount}>{subject.length}/200</Text>

          {/* Message */}
          <Text style={modalStyles.label}>Message *</Text>
          <TextInput
            style={modalStyles.textArea}
            placeholder="Describe your complaint in detail..."
            placeholderTextColor="#9CA3AF"
            value={message}
            onChangeText={setMessage}
            maxLength={1000}
            multiline
            textAlignVertical="top"
            editable={!submitting}
            accessibilityLabel="Complaint message"
          />
          <Text style={modalStyles.charCount}>{message.length}/1000</Text>

          {/* Submit */}
          <TouchableOpacity
            style={[modalStyles.submitBtn, submitting && modalStyles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Submit complaint"
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={modalStyles.submitBtnText}>Submit Complaint</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827', flex: 1 },
  closeBtn: { fontSize: 18, color: '#9CA3AF', paddingLeft: 12 },
  label: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
    marginBottom: 4,
  },
  textArea: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
    minHeight: 120,
    marginBottom: 4,
  },
  charCount: { fontSize: 11, color: '#9CA3AF', textAlign: 'right', marginBottom: 16 },
  submitBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
});

// ── Complaint detail modal ────────────────────────────────────────────────────

function ComplaintDetailModal({
  complaint,
  onClose,
}: {
  complaint: Complaint | null;
  onClose: () => void;
}) {
  if (!complaint) return null;
  return (
    <Modal
      visible={!!complaint}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={detailStyles.overlay}>
        <View style={detailStyles.sheet}>
          <View style={detailStyles.header}>
            <Text style={detailStyles.title}>Complaint Details</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={detailStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={[detailStyles.statusBadge, { backgroundColor: statusBg(complaint.status) }]}>
            <Text style={[detailStyles.statusText, { color: statusColor(complaint.status) }]}>
              {complaint.status.charAt(0).toUpperCase() + complaint.status.slice(1)}
            </Text>
          </View>
          {complaint.subject ? (
            <Text style={detailStyles.subject}>{complaint.subject}</Text>
          ) : null}
          <Text style={detailStyles.message}>{complaint.message}</Text>
          <Text style={detailStyles.meta}>
            {complaint.recipient_type === 'class_teacher' ? 'To: Class Teacher' : 'To: School Admin'} ·{' '}
            {timeAgo(complaint.created_at)}
          </Text>
          {complaint.response ? (
            <View style={detailStyles.responseBox}>
              <Text style={detailStyles.responseLabel}>Response</Text>
              <Text style={detailStyles.responseText}>{complaint.response}</Text>
            </View>
          ) : (
            <Text style={detailStyles.noResponse}>No response yet. You will be notified when reviewed.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const detailStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  closeBtn: { fontSize: 18, color: '#9CA3AF' },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 12,
  },
  statusText: { fontSize: 13, fontWeight: '700' },
  subject: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 6 },
  message: { fontSize: 14, color: '#374151', lineHeight: 21, marginBottom: 8 },
  meta: { fontSize: 12, color: '#9CA3AF', marginBottom: 16 },
  responseBox: {
    backgroundColor: '#F0FDF4',
    borderRadius: 10,
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
  },
  responseLabel: { fontSize: 12, fontWeight: '700', color: '#15803D', marginBottom: 6 },
  responseText: { fontSize: 14, color: '#374151', lineHeight: 20 },
  noResponse: { fontSize: 13, color: '#9CA3AF', fontStyle: 'italic' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function ComplaintsScreen() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalRecipient, setModalRecipient] = useState<RecipientType | null>(null);
  const [selectedComplaint, setSelectedComplaint] = useState<Complaint | null>(null);
  const [successMessage, setSuccessMessage] = useState('');

  const fetchComplaints = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/complaints');
      setComplaints(response.data.data ?? []);
    } catch (err) {
      console.warn('[Complaints] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchComplaints(); }, [fetchComplaints]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchComplaints();
  }, [fetchComplaints]);

  const handleSubmit = async (
    subject: string,
    message: string,
    recipientType: RecipientType
  ) => {
    await apiClient.post('/api/complaints', {
      subject: subject || null,
      message,
      recipient_type: recipientType,
    });
    setSuccessMessage('Complaint submitted. You will be notified when reviewed.');
    setTimeout(() => setSuccessMessage(''), 4000);
    fetchComplaints();
  };

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
        <Text style={styles.title}>Submit a Complaint</Text>

        {/* Success message */}
        {successMessage !== '' && (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>✓ {successMessage}</Text>
          </View>
        )}

        {/* Option buttons */}
        <TouchableOpacity
          style={[styles.optionButton, styles.optionBlue]}
          onPress={() => setModalRecipient('class_teacher')}
          accessibilityRole="button"
          accessibilityLabel="Complain to my class teacher"
        >
          <Text style={styles.optionIcon}>👨‍🏫</Text>
          <View style={styles.optionText}>
            <Text style={styles.optionTitle}>Complain to My Class Teacher</Text>
            <Text style={styles.optionDesc}>For classroom related issues</Text>
          </View>
          <Text style={styles.optionArrow}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.optionButton, styles.optionOrange]}
          onPress={() => setModalRecipient('school_admin')}
          accessibilityRole="button"
          accessibilityLabel="Complain to school admin"
        >
          <Text style={styles.optionIcon}>🏫</Text>
          <View style={styles.optionText}>
            <Text style={[styles.optionTitle, { color: '#92400E' }]}>Complain to School Admin</Text>
            <Text style={[styles.optionDesc, { color: '#B45309' }]}>For school related issues</Text>
          </View>
          <Text style={[styles.optionArrow, { color: '#B45309' }]}>›</Text>
        </TouchableOpacity>

        {/* Previous complaints */}
        <Text style={styles.sectionTitle}>My Previous Complaints</Text>

        {loading ? (
          <ActivityIndicator size="large" color="#1D4ED8" style={{ marginTop: 24 }} />
        ) : complaints.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No complaints submitted yet.</Text>
          </View>
        ) : (
          complaints.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={styles.complaintCard}
              onPress={() => setSelectedComplaint(c)}
              accessibilityRole="button"
              accessibilityLabel={`Complaint: ${c.subject ?? 'No subject'}. Status: ${c.status}`}
            >
              <View style={styles.complaintHeader}>
                <Text style={styles.complaintSubject} numberOfLines={1}>
                  {c.subject ?? 'No subject'}
                </Text>
                <View style={[styles.statusBadge, { backgroundColor: statusBg(c.status) }]}>
                  <Text style={[styles.statusText, { color: statusColor(c.status) }]}>
                    {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                  </Text>
                </View>
              </View>
              <Text style={styles.complaintMeta}>
                {c.recipient_type === 'class_teacher' ? 'Class Teacher' : 'School Admin'} ·{' '}
                {timeAgo(c.created_at)}
              </Text>
              <Text style={styles.complaintPreview} numberOfLines={2}>
                {c.message}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      {/* Complaint form modal */}
      {modalRecipient && (
        <ComplaintModal
          visible={!!modalRecipient}
          recipientType={modalRecipient}
          onClose={() => setModalRecipient(null)}
          onSubmit={handleSubmit}
        />
      )}

      {/* Complaint detail modal */}
      <ComplaintDetailModal
        complaint={selectedComplaint}
        onClose={() => setSelectedComplaint(null)}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 20 },
  successBanner: {
    backgroundColor: '#DCFCE7',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
  },
  successText: { fontSize: 14, color: '#15803D', fontWeight: '600' },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 18,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  optionBlue: { backgroundColor: '#EFF6FF', borderLeftWidth: 4, borderLeftColor: '#1D4ED8' },
  optionOrange: { backgroundColor: '#FFFBEB', borderLeftWidth: 4, borderLeftColor: '#F59E0B' },
  optionIcon: { fontSize: 28, marginRight: 14 },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 15, fontWeight: '700', color: '#1E3A8A', marginBottom: 3 },
  optionDesc: { fontSize: 12, color: '#3B82F6' },
  optionArrow: { fontSize: 22, color: '#1D4ED8', fontWeight: '300' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginTop: 8, marginBottom: 14 },
  emptyState: { alignItems: 'center', marginTop: 24 },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyText: { fontSize: 14, color: '#9CA3AF' },
  complaintCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  complaintHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  complaintSubject: { fontSize: 14, fontWeight: '700', color: '#111827', flex: 1, marginRight: 8 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: '700' },
  complaintMeta: { fontSize: 11, color: '#9CA3AF', marginBottom: 6 },
  complaintPreview: { fontSize: 13, color: '#6B7280', lineHeight: 18 },
});
