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
  FlatList,
} from 'react-native';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type RecipientType = 'school_admin' | 'subject_teacher';

interface Complaint {
  id: string;
  subject: string | null;
  message: string;
  recipient_type: RecipientType;
  status: 'pending' | 'reviewed' | 'resolved';
  resolution_note: string | null;
  created_at: string;
}

interface SubjectTeacher {
  teacher_id: string;
  teacher_name: string;
  subject: string | null;
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

/**
 * Parse an ISO timestamp as UTC. Supabase may return timestamptz values without
 * a timezone designator, which JavaScript would interpret as local time — causing
 * timestamps to appear shifted by the device UTC offset (e.g. +5:30h for IST).
 */
function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - parseUtcDate(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function recipientLabel(c: Complaint): string {
  switch (c.recipient_type) {
    case 'subject_teacher': return 'Subject Teacher';
    case 'school_admin':    return 'School Admin';
    default:                return 'Unknown';
  }
}

// ── Subject teacher picker modal ──────────────────────────────────────────────

function SubjectPickerModal({
  visible,
  teachers,
  loading,
  onSelect,
  onClose,
}: {
  visible: boolean;
  teachers: SubjectTeacher[];
  loading: boolean;
  onSelect: (teacher: SubjectTeacher) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={pickerStyles.overlay}>
        <View style={pickerStyles.sheet}>
          <View style={pickerStyles.header}>
            <Text style={pickerStyles.title}>Select Subject Teacher</Text>
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={pickerStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={pickerStyles.subtitle}>
            Choose the teacher you want to send your complaint to.
          </Text>
          {loading ? (
            <ActivityIndicator size="large" color="#1D4ED8" style={{ marginTop: 24 }} />
          ) : teachers.length === 0 ? (
            <View style={pickerStyles.empty}>
              <Text style={pickerStyles.emptyText}>
                No subject teachers found for your class.
              </Text>
            </View>
          ) : (
            <FlatList
              data={teachers}
              keyExtractor={(item) => item.teacher_id + (item.subject ?? '')}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={pickerStyles.teacherRow}
                  onPress={() => onSelect(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.teacher_name}${item.subject ? ', ' + item.subject : ''}`}
                >
                  <View style={pickerStyles.teacherIcon}>
                    <Text style={pickerStyles.teacherIconText}>
                      {item.teacher_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={pickerStyles.teacherInfo}>
                    <Text style={pickerStyles.teacherName}>{item.teacher_name}</Text>
                    {item.subject ? (
                      <Text style={pickerStyles.teacherSubject}>{item.subject}</Text>
                    ) : null}
                  </View>
                  <Text style={pickerStyles.arrow}>›</Text>
                </TouchableOpacity>
              )}
              style={{ maxHeight: 360 }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const pickerStyles = StyleSheet.create({
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
    marginBottom: 8,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  closeBtn: { fontSize: 18, color: '#9CA3AF', paddingLeft: 12 },
  subtitle: { fontSize: 13, color: '#6B7280', marginBottom: 16 },
  empty: { alignItems: 'center', paddingVertical: 24 },
  emptyText: { fontSize: 14, color: '#9CA3AF' },
  teacherRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  teacherIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  teacherIconText: { fontSize: 16, fontWeight: '700', color: '#1D4ED8' },
  teacherInfo: { flex: 1 },
  teacherName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  teacherSubject: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  arrow: { fontSize: 20, color: '#D1D5DB' },
});

// ── Complaint form modal ──────────────────────────────────────────────────────

function ComplaintModal({
  visible,
  recipientType,
  selectedTeacher,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  recipientType: RecipientType;
  selectedTeacher: SubjectTeacher | null;
  onClose: () => void;
  onSubmit: (
    subject: string,
    message: string,
    recipientType: RecipientType,
    teacherId?: string
  ) => Promise<void>;
}) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const title =
    recipientType === 'subject_teacher'
      ? `Complain to ${selectedTeacher?.teacher_name ?? 'Subject Teacher'}`
      : 'Complain to School Admin';

  const handleSubmit = async () => {
    if (!message.trim()) {
      Alert.alert('Required', 'Please enter your complaint message.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(
        subject.trim(),
        message.trim(),
        recipientType,
        recipientType === 'subject_teacher' ? selectedTeacher?.teacher_id : undefined
      );
      setSubject('');
      setMessage('');
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string; errors?: { fieldErrors?: Record<string, string[]> } } } };
      const data = axiosErr?.response?.data;
      // Try to get a human-readable message from field errors first
      let msg = data?.message ?? 'Failed to submit complaint. Please try again.';
      if (data?.errors?.fieldErrors) {
        const fieldMsgs = Object.entries(data.errors.fieldErrors)
          .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
          .join('\n');
        if (fieldMsgs) msg = fieldMsgs;
      }
      Alert.alert('Error', msg);
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

          {/* Subject teacher badge */}
          {recipientType === 'subject_teacher' && selectedTeacher?.subject ? (
            <View style={modalStyles.teacherBadge}>
              <Text style={modalStyles.teacherBadgeText}>
                📚 Subject: {selectedTeacher.subject}
              </Text>
            </View>
          ) : null}

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
  teacherBadge: {
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 16,
  },
  teacherBadgeText: { fontSize: 13, color: '#1D4ED8', fontWeight: '600' },
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
            To: {recipientLabel(complaint)} · {timeAgo(complaint.created_at)}
          </Text>
          {complaint.resolution_note ? (
            <View style={detailStyles.responseBox}>
              <Text style={detailStyles.responseLabel}>Response</Text>
              <Text style={detailStyles.responseText}>{complaint.resolution_note}</Text>
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

  // Subject teacher picker state
  const [showTeacherPicker, setShowTeacherPicker] = useState(false);
  const [teachers, setTeachers] = useState<SubjectTeacher[]>([]);
  const [teachersLoading, setTeachersLoading] = useState(false);
  const [selectedTeacher, setSelectedTeacher] = useState<SubjectTeacher | null>(null);

  const fetchComplaints = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/complaints/student');
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

  const fetchTeachers = useCallback(async () => {
    setTeachersLoading(true);
    try {
      const response = await apiClient.get('/api/complaints/my-teachers');
      setTeachers(response.data.data ?? []);
    } catch (err) {
      console.warn('[Complaints] fetch teachers error:', err);
      setTeachers([]);
    } finally {
      setTeachersLoading(false);
    }
  }, []);

  const handleSubjectTeacherPress = useCallback(async () => {
    setShowTeacherPicker(true);
    await fetchTeachers();
  }, [fetchTeachers]);

  const handleTeacherSelect = useCallback((teacher: SubjectTeacher) => {
    setSelectedTeacher(teacher);
    setShowTeacherPicker(false);
    setModalRecipient('subject_teacher');
  }, []);

  const handleSubmit = async (
    subject: string,
    message: string,
    recipientType: RecipientType,
    teacherId?: string
  ) => {
    await apiClient.post('/api/complaints', {
      ...(subject ? { subject } : {}),
      message,
      recipient_type: recipientType,
      ...(teacherId ? { subject_teacher_id: teacherId } : {}),
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

        {/* Complain to Subject Teacher */}
        <TouchableOpacity
          style={[styles.optionButton, styles.optionGreen]}
          onPress={handleSubjectTeacherPress}
          accessibilityRole="button"
          accessibilityLabel="Complain to a subject teacher"
        >
          <Text style={styles.optionIcon}>📚</Text>
          <View style={styles.optionText}>
            <Text style={[styles.optionTitle, { color: '#065F46' }]}>
              Complain to Subject Teacher
            </Text>
            <Text style={[styles.optionDesc, { color: '#059669' }]}>
              Select a subject, goes only to that teacher
            </Text>
          </View>
          <Text style={[styles.optionArrow, { color: '#059669' }]}>›</Text>
        </TouchableOpacity>

        {/* Complain to School Admin */}
        <TouchableOpacity
          style={[styles.optionButton, styles.optionOrange]}
          onPress={() => setModalRecipient('school_admin')}
          accessibilityRole="button"
          accessibilityLabel="Complain to school admin"
        >
          <Text style={styles.optionIcon}>🏫</Text>
          <View style={styles.optionText}>
            <Text style={[styles.optionTitle, { color: '#92400E' }]}>
              Complain to School Admin
            </Text>
            <Text style={[styles.optionDesc, { color: '#B45309' }]}>
              For school-wide issues
            </Text>
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
                {recipientLabel(c)} · {timeAgo(c.created_at)}
              </Text>
              <Text style={styles.complaintPreview} numberOfLines={2}>
                {c.message}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      {/* Subject teacher picker */}
      <SubjectPickerModal
        visible={showTeacherPicker}
        teachers={teachers}
        loading={teachersLoading}
        onSelect={handleTeacherSelect}
        onClose={() => setShowTeacherPicker(false)}
      />

      {/* Complaint form modal */}
      {modalRecipient && (
        <ComplaintModal
          visible={!!modalRecipient}
          recipientType={modalRecipient}
          selectedTeacher={selectedTeacher}
          onClose={() => {
            setModalRecipient(null);
            setSelectedTeacher(null);
          }}
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
  optionBlue:   { backgroundColor: '#EFF6FF', borderLeftWidth: 4, borderLeftColor: '#1D4ED8' },
  optionGreen:  { backgroundColor: '#F0FDF4', borderLeftWidth: 4, borderLeftColor: '#10B981' },
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
