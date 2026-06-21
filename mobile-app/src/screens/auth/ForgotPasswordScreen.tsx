import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { AuthStackParamList } from '../../navigation/AppNavigator';

const PRIMARY = '#3b82f6';

// ── Component ─────────────────────────────────────────────────────────────────

export default function ForgotPasswordScreen() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const navigation = useNavigation<StackNavigationProp<AuthStackParamList>>();

  const handleSendOtp = async () => {
    setErrorMessage('');

    if (!phone.trim()) {
      setErrorMessage('Please enter your phone number.');
      return;
    }
    if (phone.trim().length < 10) {
      setErrorMessage('Please enter a valid 10-digit phone number.');
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/api/auth/student/forgot-password', {
        phone_number: phone.trim(),
      });

      // Always navigate to OTP screen — backend never reveals whether phone exists
      navigation.navigate('OTPVerification', { phone: phone.trim() });
    } catch {
      // Network or server error — still navigate so we don't leak phone existence
      navigation.navigate('OTPVerification', { phone: phone.trim() });
    } finally {
      setLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Back */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>← Back to Login</Text>
        </TouchableOpacity>

        {/* Header */}
        <Text style={styles.title}>Forgot Password?</Text>
        <Text style={styles.subtitle}>
          Enter your registered phone number. We'll send a 6-digit OTP to your
          WhatsApp.
        </Text>

        {/* Phone input */}
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
          accessibilityLabel="Phone number"
        />

        {errorMessage !== '' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSendOtp}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Send OTP"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Send OTP via WhatsApp</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.note}>
          The OTP will be sent to the WhatsApp number registered with your school.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 48,
  },
  backButton: {
    marginBottom: 32,
  },
  backText: {
    fontSize: 14,
    color: PRIMARY,
    fontWeight: '500',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 21,
    marginBottom: 32,
  },
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
  errorText: {
    color: '#EF4444',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
  },
  button: {
    backgroundColor: PRIMARY,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  note: {
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },
});
