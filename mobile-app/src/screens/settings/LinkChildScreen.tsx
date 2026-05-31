import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StatusBar,
} from 'react-native';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoginResponse {
  success: boolean;
  data: {
    token: string;
    student: {
      id: string;
      name: string;
      phone: string;
      class: string;
      section: string;
      school_id: string;
      roll_number?: string | null;
    };
  };
  message?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LinkChildScreen() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const { linkedChildren, addChild, removeChild } = useChildStore();

  const handleLink = async () => {
    setErrorMessage('');
    setSuccessMessage('');

    if (!phone.trim() || phone.trim().length < 10) {
      setErrorMessage('Please enter a valid 10-digit phone number.');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('Please enter the password.');
      return;
    }

    // Check if already linked
    if (linkedChildren.some((c) => c.phone === phone.trim())) {
      setErrorMessage('This child is already linked to your account.');
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.post<LoginResponse>('/api/auth/login/student', {
        phone: phone.trim(),
        password,
      });

      const { token, student } = response.data.data;

      addChild({
        id: student.id,
        phone: student.phone,
        token,
        name: student.name,
        class: student.class,
        section: student.section,
        school_id: student.school_id,
        roll_number: student.roll_number,
      });

      setPhone('');
      setPassword('');
      setSuccessMessage(
        `${student.name} linked! You can now switch between children from the home screen.`
      );
    } catch (error: any) {
      const message =
        error.response?.data?.message ?? 'Failed to link account. Check credentials.';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = (phone: string, name: string) => {
    Alert.alert(
      'Remove Child',
      `Remove ${name} from linked accounts?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeChild(phone),
        },
      ]
    );
  };

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Link Another Child</Text>
        <Text style={styles.subtitle}>
          If you have another child in this school, link their account here to switch between them from the home screen.
        </Text>

        {/* Success message */}
        {successMessage !== '' && (
          <View style={styles.successBanner}>
            <Text style={styles.successText}>✓ {successMessage}</Text>
          </View>
        )}

        {/* Phone input */}
        <Text style={styles.label}>Phone Number</Text>
        <TextInput
          style={styles.input}
          placeholder="10-digit phone number"
          placeholderTextColor="#9CA3AF"
          keyboardType="number-pad"
          maxLength={10}
          value={phone}
          onChangeText={(v) => {
            setPhone(v.replace(/[^0-9]/g, ''));
            setErrorMessage('');
          }}
          editable={!loading}
          accessibilityLabel="Child phone number"
        />

        {/* Password input */}
        <Text style={styles.label}>Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Child's password"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setErrorMessage('');
            }}
            editable={!loading}
            accessibilityLabel="Child password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowPassword((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
          >
            <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {/* Error */}
        {errorMessage !== '' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        {/* Link button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLink}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Link account"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Link Account</Text>
          )}
        </TouchableOpacity>

        {/* Linked children list */}
        {linkedChildren.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Linked Children</Text>
            {linkedChildren.map((child) => (
              <View key={child.phone} style={styles.childCard}>
                <View style={styles.childAvatar}>
                  <Text style={styles.childAvatarText}>
                    {child.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.childInfo}>
                  <Text style={styles.childName}>{child.name}</Text>
                  <Text style={styles.childMeta}>
                    Class {child.class} {child.section} · {child.phone}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => handleRemove(child.phone, child.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${child.name}`}
                >
                  <Text style={styles.removeText}>Remove</Text>
                </TouchableOpacity>
              </View>
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
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#6B7280', lineHeight: 21, marginBottom: 24 },
  successBanner: {
    backgroundColor: '#DCFCE7',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
  },
  successText: { fontSize: 14, color: '#15803D', fontWeight: '600', lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#111827',
    marginBottom: 16,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    marginBottom: 16,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#111827',
  },
  toggleButton: { paddingHorizontal: 14, paddingVertical: 14 },
  toggleText: { fontSize: 14, color: '#3B82F6', fontWeight: '500' },
  errorText: { color: '#EF4444', fontSize: 14, marginBottom: 12, textAlign: 'center' },
  button: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 28,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 12,
  },
  childCard: {
    flexDirection: 'row',
    alignItems: 'center',
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
  childAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  childAvatarText: { fontSize: 18, fontWeight: '700', color: '#1D4ED8' },
  childInfo: { flex: 1 },
  childName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  childMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  removeButton: {
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  removeText: { fontSize: 13, color: '#EF4444', fontWeight: '600' },
});
