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
import { parseUtcDate, timeAgo } from '../../utils/dateUtils';

// ── Types ─────────────────────────────────────────────────────────────────────

type RecipientType = 'school_admin' | 'subject_teacher';

interface StudentRequest {
  id: string;
  subject: string | null;
  message: string;
  recipient_type: RecipientType;
  status: 'pending' | 'approved' | 'rejected';
  resolution_note: string | null;
  created_at: string;
}

interface SubjectTeacher {
  teacher_id: string;
  teacher_name: string;
  subject: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: StudentRequest['status']): string {
  switch (status) {
    case 'pending':  return '#F59E0B';
    case 'approved': return '#22C55E';
    case 'rejected': return '#EF4444';
    default:         return '#9CA3AF';
  }
}

function statusBg(status: StudentRequest['status']): string {
  switch (status) {
    case 'pending':  return '#FEF3C7';
    case 'approved': return '#DCFCE7';
    case 'rejected': return '#FEE2E2';
    default:         return '#F3F4F6';
  }
}

function recipientLabel(r: StudentRequest): string {
  switch (r.recipient_type) {
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
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={pickerStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={pickerStyles.subtitle}>
            Choose the teacher you want to send your request to.
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
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
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
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  teacherIconText: { fontSize: 16, fontWeight: '700', color: '#1D4ED8' },
  teacherInfo: { flex: 1 },
  teacherName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  teacherSubject: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  arrow: { fontSize: 20, color: '#D1D5DB' },
});

// ── Request form modal ────────────────────────────────────────────────────────

function RequestModal({
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
      ? `Request to ${selectedTeacher?.teacher_name ?? 'Subject Teacher'}`
      : 'Request to School Admin';

  const handleSubmit = async () => {
    if (!message.trim()) {
      Alert.alert('Required', 'Please enter your request message.');
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
      let msg = data?.message ?? 'Failed to submit request. Please try again.';
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
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={modalStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          {recipientType === 'subject_teacher' && selectedTeacher?.subject ? (
            <View style={modalStyles.teacherBadge}>
              <Text style={modalStyles.teacherBadgeText}>
                📚 Subject: {selectedTeacher.subject}
              </Text>
            </View>
          ) : null}

          <Text style={modalStyles.label}>Subject (optional)</Text>
          <TextInput
            style={modalStyles.input}
            placeholder="Brief subject..."
            placeholderTextColor="#9CA3AF"
            value={subject}
            onChangeText={setSubject}
            maxLength={200}
            editable={!submitting}
            accessibilityLabel="Request subject"
          />
          <Text style={modalStyles.charCount}>{subject.length}/200</Text>

          <Text style={modalStyles.label}>Message *</Text>
          <TextInput
            style={modalStyles.textArea}
            placeholder="Describe your request in detail..."
            placeholderTextColor="#9CA3AF"
            value={message}
            onChangeText={setMessage}
            maxLength={1000}
            multiline
            textAlignVertical="top"
            editable={!submitting}
            accessibilityLabel="Request message"
          />
          <Text style={modalStyles.charCount}>{message.length}/1000</Text>

          <TouchableOpacity
            style={[modalStyles.submitBtn, submitting && modalStyles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Submit request"
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={modalStyles.submitBtnText}>Submit Request</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
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
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
});

// ── Request detail modal ──────────────────────────────────────────────────────

function RequestDetailModal({
  request,
  onClose,
}: {
  request: StudentRequest | null;
  onClose: () => void;
}) {
  if (!request) return null;
  return (
    <Modal
      visible={!!request}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={detailStyles.overlay}>
        <View style={detailStyles.sheet}>
          <View style={detailStyles.header}>
            <Text style={detailStyles.title}>Request Details</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={detailStyles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={[detailStyles.statusBadge, { backgroundColor: statusBg(request.status) }]}>
            <Text style={[detailStyles.statusText, { color: statusColor(request.status) }]}>
              {request.status.charAt(0).toUpperCase() + request.status.slice(1)}
            </Text>
          </View>
          {request.subject ? (
            <Text style={detailStyles.subject}>{request.subject}</Text>
          ) : null}
          <Text style={detailStyles.message}>{request.message}</Text>
          <Text style={detailStyles.meta}>
            To: {recipientLabel(request)} · {timeAgo(request.created_at)}
          </Text>
          {request.resolution_note ? (
            <View style={[
              detailStyles.responseBox,
              request.status === 'approved'
                ? detailStyles.responseBoxApproved
                : detailStyles.responseBoxRejected,
            ]}>
              <Text style={[
                detailStyles.responseLabel,
                request.status === 'rejected' && { color: '#DC2626' },
              ]}>
                {request.status === 'approved' ? 'Approval Note' : 'Rejection Reason'}
              </Text>
              <Text style={detailStyles.responseText}>{request.resolution_note}</Text>
            </View>
          ) : request.status === 'pending' ? (
            <Text style={detailStyles.noResponse}>
              No response yet. You will be notified when reviewed.
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const detailStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  closeBtn: { fontSize: 18, color: '#9CA3AF' },
  statusBadge: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, marginBottom: 12 },
  statusText: { fontSize: 13, fontWeight: '700' },
  subject: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 6 },
  message: { fontSize: 14, color: '#374151', lineHeight: 21, marginBottom: 8 },
  meta: { fontSize: 12, color: '#9CA3AF', marginBottom: 16 },
  responseBox: { borderRadius: 10, padding: 14, borderLeftWidth: 3 },
  responseBoxApproved: { backgroundColor: '#F0FDF4', borderLeftColor: '#22C55E' },
  responseBoxRejected: { backgroundColor: '#FFF5F5', borderLeftColor: '#EF4444' },
  responseLabel: { fontSize: 12, fontWeight: '700', color: '#15803D', marginBottom: 6 },
  responseText: { fontSize: 14, color: '#374151', lineHeight: 20 },
  noResponse: { fontSize: 13, color: '#9CA3AF', fontStyle: 'italic' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function RequestsScreen() {
  const [requests, setRequests] = useState<StudentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalRecipient, setModalRecipient] = useState<RecipientType | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<StudentRequest | null>(null);
  const [successMessage, setSuccessMessage] = useState('');

  // Subject teacher picker state
  const [showTeacherPicker, setShowTeacherPicker] = useState(false);
  const [teachers, setTeachers] = useState<SubjectTeacher[]>([]);
  const [teachersLoading, setTeachersLoading] = useState(false);
  const [selectedTeacher, setSelectedTeacher] = useState<SubjectTeacher | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/requests/student');
      setRequests(response.data.data ?? []);
    } catch (err) {
      console.warn('[Requests] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchRequests();
  }, [fetchRequests]);

  const fetchTeachers = useCallback(async () => {
    setTeachersLoading(true);
    try {
      const response = await apiClient.get('/api/requests/my-teachers');
      setTeachers(response.data.data ?? []);
    } catch (err) {
      console.warn('[Requests] fetch teachers error:', err);
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
    await apiClient.post('/api/requests', {
      ...(subject ? { subject } : {}),
      message,
      recipient_type: recipientType,
      ...(teacherId ? { subject_teacher_id: teacherId } : {}),
    });
    setSuccessMessage('Request submitted. You will be notified when reviewed.');
    setTimeout(() => setSuccessMessage(''), 4000);
    fetchRequests();
  };

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7C3AED" />
        }
      >
        <Text style={styles.title}>Submit a Request</Text>

        {successMessage !== '' && (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>✓ {successMessage}</Text>
          </View>
        )}

        {/* Request to Subject Teacher */}
        <TouchableOpacity
          style={[styles.optionButton, styles.optionGreen]}
          onPress={handleSubjectTeacherPress}
          accessibilityRole="button"
          accessibilityLabel="Request to a subject teacher"
        >
          <Text style={styles.optionIcon}>📚</Text>
          <View style={styles.optionText}>
            <Text style={[styles.optionTitle, { color: '#065F46' }]}>
              Request to Subject Teacher
            </Text>
            <Text style={[styles.optionDesc, { color: '#059669' }]}>
              Select a subject teacher to send your request
            </Text>
          </View>
          <Text style={[styles.optionArrow, { color: '#059669' }]}>›</Text>
        </TouchableOpacity>

        {/* Request to School Admin */}
        <TouchableOpacity
          style={[styles.optionButton, styles.optionPurple]}
          onPress={() => setModalRecipient('school_admin')}
          accessibilityRole="button"
          accessibilityLabel="Request to school admin"
        >
          <Text style={styles.optionIcon}>🏫</Text>
          <View style={styles.optionText}>
            <Text style={[styles.optionTitle, { color: '#5B21B6' }]}>
              Request to School Admin
            </Text>
            <Text style={[styles.optionDesc, { color: '#7C3AED' }]}>
              For school-wide requests
            </Text>
          </View>
          <Text style={[styles.optionArrow, { color: '#7C3AED' }]}>›</Text>
        </TouchableOpacity>

        {/* Previous requests */}
        <Text style={styles.sectionTitle}>My Previous Requests</Text>

        {loading ? (
          <ActivityIndicator size="large" color="#7C3AED" style={{ marginTop: 24 }} />
        ) : requests.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No requests submitted yet.</Text>
          </View>
        ) : (
          requests.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={styles.requestCard}
              onPress={() => setSelectedRequest(r)}
              accessibilityRole="button"
              accessibilityLabel={`Request: ${r.subject ?? 'No subject'}. Status: ${r.status}`}
            >
              <View style={styles.requestHeader}>
                <Text style={styles.requestSubject} numberOfLines={1}>
                  {r.subject ?? 'No subject'}
                </Text>
                <View style={[styles.statusBadge, { backgroundColor: statusBg(r.status) }]}>
                  <Text style={[styles.statusText, { color: statusColor(r.status) }]}>
                    {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                  </Text>
                </View>
              </View>
              <Text style={styles.requestMeta}>
                {recipientLabel(r)} · {timeAgo(r.created_at)}
              </Text>
              <Text style={styles.requestPreview} numberOfLines={2}>
                {r.message}
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

      {/* Request form modal */}
      {modalRecipient && (
        <RequestModal
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

      {/* Request detail modal */}
      <RequestDetailModal
        request={selectedRequest}
        onClose={() => setSelectedRequest(null)}
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
  optionGreen:  { backgroundColor: '#F0FDF4', borderLeftWidth: 4, borderLeftColor: '#10B981' },
  optionPurple: { backgroundColor: '#F5F3FF', borderLeftWidth: 4, borderLeftColor: '#7C3AED' },
  optionIcon: { fontSize: 28, marginRight: 14 },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 3 },
  optionDesc: { fontSize: 12 },
  optionArrow: { fontSize: 22, fontWeight: '300' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginTop: 8, marginBottom: 14 },
  emptyState: { alignItems: 'center', marginTop: 24 },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyText: { fontSize: 14, color: '#9CA3AF' },
  requestCard: {
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
  requestHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  requestSubject: { fontSize: 14, fontWeight: '700', color: '#111827', flex: 1, marginRight: 8 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: '700' },
  requestMeta: { fontSize: 11, color: '#9CA3AF', marginBottom: 6 },
  requestPreview: { fontSize: 13, color: '#6B7280', lineHeight: 18 },
});
