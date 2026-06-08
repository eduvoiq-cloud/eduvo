import React, { useState, useRef } from 'react';
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
  Linking,
} from 'react-native';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour
const PRIMARY = '#3b82f6';
const PRIVACY_URL = 'https://eduvo.vercel.app/privacy-policy';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoginResponse {
  success: boolean;
  data: {
    token: string;
    must_change_password: boolean;
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const attemptCount = useRef(0);
  const lockoutUntil = useRef<number | null>(null);

  const login = useAuthStore((state) => state.login);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isLockedOut = (): boolean => {
    if (lockoutUntil.current === null) return false;
    if (Date.now() < lockoutUntil.current) return true;
    lockoutUntil.current = null;
    attemptCount.current = 0;
    return false;
  };

  const remainingLockoutMinutes = (): number => {
    if (lockoutUntil.current === null) return 0;
    return Math.ceil((lockoutUntil.current - Date.now()) / 60000);
  };

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleLogin = async () => {
    setErrorMessage('');

    if (isLockedOut()) {
      setErrorMessage(
        `Too many attempts. Try again in ${remainingLockoutMinutes()} minute(s).`
      );
      return;
    }

    if (!phone.trim()) {
      setErrorMessage('Please enter your phone number.');
      return;
    }
    if (phone.trim().length < 10) {
      setErrorMessage('Please enter a valid 10-digit phone number.');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.post<LoginResponse>('/api/auth/login/student', {
        phone_number: phone.trim(),
        password,
      });

      const { token, student, must_change_password } = response.data.data;

      attemptCount.current = 0;
      lockoutUntil.current = null;

      login(
        {
          id: student.id,
          name: student.name,
          phone: student.phone,
          class: student.class,
          section: student.section,
          school_id: student.school_id,
          roll_number: student.roll_number,
        },
        token,
        must_change_password
      );
      // AppNavigator handles routing based on isFirstLogin
    } catch (error: any) {
      attemptCount.current += 1;

      if (attemptCount.current >= MAX_ATTEMPTS) {
        lockoutUntil.current = Date.now() + LOCKOUT_DURATION_MS;
        setErrorMessage('Too many attempts. Try again in 1 hour.');
      } else {
        const message =
          error.response?.data?.message ?? 'Login failed. Please check your credentials.';
        setErrorMessage(message);
      }
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
        {/* Logo */}
        <Text style={styles.logo}>Eduvo</Text>

        {/* Subtitle */}
        <Text style={styles.subtitle}>Student / Parent Login</Text>

        {/* Phone input */}
        <TextInput
          style={styles.input}
          placeholder="Phone number"
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

        {/* Password input with show/hide toggle */}
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Password"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setErrorMessage('');
            }}
            editable={!loading}
            accessibilityLabel="Password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowPassword((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
          >
            <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {/* Inline error message */}
        {errorMessage !== '' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        {/* Login button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Log in"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Log In</Text>
          )}
        </TouchableOpacity>

        {/* Forgot password hint */}
        <Text style={styles.forgotText}>
          Forgot password? Contact your school.
        </Text>

        {/* Privacy policy link */}
        <TouchableOpacity
          style={styles.privacyLink}
          onPress={() => Linking.openURL(PRIVACY_URL)}
          accessibilityRole="link"
          accessibilityLabel="Privacy Policy"
        >
          <Text style={styles.privacyText}>Privacy Policy</Text>
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
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  logo: {
    fontSize: 40,
    fontWeight: '700',
    color: PRIMARY,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 40,
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
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  forgotText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 20,
  },
  privacyLink: {
    alignSelf: 'center',
    marginTop: 12,
  },
  privacyText: {
    fontSize: 12,
    color: PRIMARY,
    fontWeight: '500',
  },
});
