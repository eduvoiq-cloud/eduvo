import React, { useState, useRef, useEffect } from 'react';
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
  Alert,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { AuthStackParamList } from '../../navigation/AppNavigator';

const PRIMARY = '#3b82f6';
const RESEND_COOLDOWN_SECONDS = 60;

type OTPRoute = RouteProp<AuthStackParamList, 'OTPVerification'>;

// ── Component ─────────────────────────────────────────────────────────────────

export default function OTPVerificationScreen() {
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // step 1 = verify OTP, step 2 = set new password
  const [step, setStep] = useState<1 | 2>(1);
  const [resetToken, setResetToken] = useState('');

  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigation = useNavigation<StackNavigationProp<AuthStackParamList>>();
  const route = useRoute<OTPRoute>();
  const { phone } = route.params;

  // Start countdown on mount
  useEffect(() => {
    startCooldown();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // ── Resend OTP ─────────────────────────────────────────────────────────────

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setResendLoading(true);
    setErrorMessage('');
    try {
      await apiClient.post('/api/auth/student/forgot-password', {
        phone_number: phone,
      });
      startCooldown();
    } catch {
      // Silent — don't reveal anything
      startCooldown();
    } finally {
      setResendLoading(false);
    }
  };

  // ── Step 1: Verify OTP ─────────────────────────────────────────────────────

  const handleVerifyOtp = async () => {
    setErrorMessage('');

    if (otp.length !== 6) {
      setErrorMessage('Please enter the 6-digit OTP.');
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.post<{
        success: boolean;
        data: { reset_token: string };
        message: string;
      }>('/api/auth/student/verify-otp', {
        phone_number: phone,
        otp: otp.trim(),
      });

      setResetToken(response.data.data.reset_token);
      setStep(2);
      setErrorMessage('');
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { message?: string } } };
      const message =
        axiosError.response?.data?.message ?? 'Invalid OTP. Please try again.';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Reset Password ─────────────────────────────────────────────────

  const handleResetPassword = async () => {
    setErrorMessage('');

    if (!newPassword.trim()) {
      setErrorMessage('Please enter a new password.');
      return;
    }
    if (newPassword.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/api/auth/student/reset-password-otp', {
        reset_token: resetToken,
        new_password: newPassword,
      });

      Alert.alert(
        'Password Reset',
        'Your password has been reset successfully. Please log in with your new password.',
        [
          {
            text: 'Log In',
            onPress: () =>
              navigation.reset({ index: 0, routes: [{ name: 'Login' }] }),
          },
        ]
      );
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { message?: string } } };
      const message =
        axiosError.response?.data?.message ??
        'Failed to reset password. Please try again.';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  };

  // ── Render: Step 1 — OTP entry ─────────────────────────────────────────────

  if (step === 1) {
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
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Enter OTP</Text>
          <Text style={styles.subtitle}>
            We've sent a 6-digit OTP to the WhatsApp number registered with your
            school for{' '}
            <Text style={styles.phoneHighlight}>
              {phone.slice(0, 2)}XXXXXX{phone.slice(-2)}
            </Text>
            .
          </Text>

          <TextInput
            style={styles.otpInput}
            placeholder="6-digit OTP"
            placeholderTextColor="#9CA3AF"
            keyboardType="number-pad"
            maxLength={6}
            value={otp}
            onChangeText={(v) => {
              setOtp(v.replace(/[^0-9]/g, ''));
              setErrorMessage('');
            }}
            editable={!loading}
            accessibilityLabel="OTP code"
          />

          {errorMessage !== '' && (
            <Text style={styles.errorText} accessibilityRole="alert">
              {errorMessage}
            </Text>
          )}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleVerifyOtp}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Verify OTP"
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Verify OTP</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <View style={styles.resendRow}>
            <Text style={styles.resendLabel}>Didn't receive it? </Text>
            <TouchableOpacity
              onPress={handleResend}
              disabled={resendCooldown > 0 || resendLoading}
              accessibilityRole="button"
              accessibilityLabel="Resend OTP"
            >
              {resendLoading ? (
                <ActivityIndicator size="small" color={PRIMARY} />
              ) : (
                <Text
                  style={[
                    styles.resendLink,
                    resendCooldown > 0 && styles.resendDisabled,
                  ]}
                >
                  {resendCooldown > 0
                    ? `Resend in ${resendCooldown}s`
                    : 'Resend OTP'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Render: Step 2 — New password ──────────────────────────────────────────

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
        <Text style={styles.title}>Set New Password</Text>
        <Text style={styles.subtitle}>
          Choose a strong password for your account.
        </Text>

        {/* New password */}
        <Text style={styles.label}>New Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Min. 6 characters"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showNewPassword}
            value={newPassword}
            onChangeText={(v) => {
              setNewPassword(v);
              setErrorMessage('');
            }}
            editable={!loading}
            accessibilityLabel="New password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowNewPassword((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={showNewPassword ? 'Hide password' : 'Show password'}
          >
            <Text style={styles.toggleText}>
              {showNewPassword ? 'Hide' : 'Show'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Confirm password */}
        <Text style={styles.label}>Confirm Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Re-enter new password"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showConfirmPassword}
            value={confirmPassword}
            onChangeText={(v) => {
              setConfirmPassword(v);
              setErrorMessage('');
            }}
            editable={!loading}
            accessibilityLabel="Confirm password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowConfirmPassword((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={
              showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
            }
          >
            <Text style={styles.toggleText}>
              {showConfirmPassword ? 'Hide' : 'Show'}
            </Text>
          </TouchableOpacity>
        </View>

        {errorMessage !== '' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleResetPassword}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Reset password"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Reset Password</Text>
          )}
        </TouchableOpacity>
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
  phoneHighlight: {
    color: '#111827',
    fontWeight: '600',
  },
  otpInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 24,
    letterSpacing: 8,
    color: '#111827',
    marginBottom: 16,
    textAlign: 'center',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    marginBottom: 20,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#111827',
  },
  toggleButton: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  toggleText: {
    fontSize: 14,
    color: PRIMARY,
    fontWeight: '500',
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
  resendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
  },
  resendLabel: {
    fontSize: 13,
    color: '#6B7280',
  },
  resendLink: {
    fontSize: 13,
    color: PRIMARY,
    fontWeight: '600',
  },
  resendDisabled: {
    color: '#9CA3AF',
  },
});
