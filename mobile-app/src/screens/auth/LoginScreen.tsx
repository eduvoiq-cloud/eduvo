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
} from 'react-native';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour
const PRIMARY = '#3b82f6';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoginResponse {
  success: boolean;
  data: {
    token: string;
    user: {
      id: string;
      name: string;
      email: string;
      role: 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';
      school_id: string | null;
    };
  };
  message?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Attempt tracking (in-memory; resets on app restart, which is acceptable)
  const attemptCount = useRef(0);
  const lockoutUntil = useRef<number | null>(null);

  const login = useAuthStore((state) => state.login);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isLockedOut = (): boolean => {
    if (lockoutUntil.current === null) return false;
    if (Date.now() < lockoutUntil.current) return true;
    // Lockout expired — reset
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

    // Lockout check
    if (isLockedOut()) {
      setErrorMessage(
        `Too many attempts. Try again in ${remainingLockoutMinutes()} minute(s).`
      );
      return;
    }

    // Basic validation
    if (!email.trim()) {
      setErrorMessage('Please enter your email address.');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.post<LoginResponse>('/api/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });

      const { token, user } = response.data.data;

      // Only parent and student roles are allowed on the mobile app
      if (user.role !== 'parent' && user.role !== 'student') {
        setErrorMessage(
          'This app is for parents and students only. Please use the web dashboard.'
        );
        return;
      }

      // Success — reset attempt counter and persist auth state
      attemptCount.current = 0;
      lockoutUntil.current = null;
      login(user, token);
      // Navigation is handled automatically by AppNavigator based on auth state
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
        <Text style={styles.subtitle}>Welcome Back</Text>

        {/* Email input */}
        <TextInput
          style={styles.input}
          placeholder="Email address"
          placeholderTextColor="#9CA3AF"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setErrorMessage('');
          }}
          editable={!loading}
          accessibilityLabel="Email address"
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
    fontSize: 18,
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
});
