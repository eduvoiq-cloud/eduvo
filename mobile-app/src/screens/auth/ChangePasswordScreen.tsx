import React, { useState, useLayoutEffect } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';
import { MainStackParamList } from '../../navigation/AppNavigator';

const PRIMARY = '#3b82f6';

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChangePasswordScreen() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const isFirstLogin = useAuthStore((s) => s.isFirstLogin);
  const markPasswordChanged = useAuthStore((s) => s.markPasswordChanged);

  const navigation = useNavigation<StackNavigationProp<MainStackParamList>>();

  // Show a header with back button only for voluntary (non-first-login) flow
  useLayoutEffect(() => {
    if (!isFirstLogin) {
      navigation.setOptions({
        headerShown: true,
        headerTitle: 'Change Password',
        headerStyle: { backgroundColor: '#1D4ED8' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
      });
    } else {
      navigation.setOptions({ headerShown: false });
    }
  }, [isFirstLogin, navigation]);

  const handleSave = async () => {
    setErrorMessage('');

    if (!currentPassword.trim()) {
      setErrorMessage('Please enter your current password.');
      return;
    }
    if (!newPassword.trim()) {
      setErrorMessage('Please enter a new password.');
      return;
    }
    if (newPassword.length < 6) {
      setErrorMessage('New password must be at least 6 characters.');
      return;
    }
    if (newPassword === currentPassword) {
      setErrorMessage('New password cannot be the same as your current password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/api/auth/student/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });

      // Always mark password changed in store
      markPasswordChanged();

      if (isFirstLogin) {
        // First-login: navigate to main app
        navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
      } else {
        // Voluntary change from Settings: go back
        Alert.alert('Password Updated', 'Your password has been changed successfully.', [
          {
            text: 'OK',
            onPress: () => {
              if (navigation.canGoBack()) {
                navigation.goBack();
              }
            },
          },
        ]);
      }
    } catch (error: any) {
      const message =
        error.response?.data?.message ?? 'Failed to change password. Please try again.';
      setErrorMessage(message);
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
        {/* Header */}
        <Text style={styles.title}>{isFirstLogin ? 'Set Your Password' : 'Change Password'}</Text>
        <Text style={styles.subtitle}>
          {isFirstLogin
            ? 'Your default password was the last 5 digits of your phone. Please set a new password.'
            : 'Enter your current password, then choose a new one.'}
        </Text>

        {/* Current password */}
        <Text style={styles.label}>Current Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Enter current password"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showCurrent}
            value={currentPassword}
            onChangeText={(v) => { setCurrentPassword(v); setErrorMessage(''); }}
            editable={!loading}
            accessibilityLabel="Current password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowCurrent((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={showCurrent ? 'Hide current password' : 'Show current password'}
          >
            <Text style={styles.toggleText}>{showCurrent ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {/* New password */}
        <Text style={styles.label}>New Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Min. 6 characters"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showNew}
            value={newPassword}
            onChangeText={(v) => { setNewPassword(v); setErrorMessage(''); }}
            editable={!loading}
            accessibilityLabel="New password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowNew((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={showNew ? 'Hide new password' : 'Show new password'}
          >
            <Text style={styles.toggleText}>{showNew ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {/* Confirm password */}
        <Text style={styles.label}>Confirm New Password</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Re-enter new password"
            placeholderTextColor="#9CA3AF"
            secureTextEntry={!showConfirm}
            value={confirmPassword}
            onChangeText={(v) => { setConfirmPassword(v); setErrorMessage(''); }}
            editable={!loading}
            accessibilityLabel="Confirm new password"
          />
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={() => setShowConfirm((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
          >
            <Text style={styles.toggleText}>{showConfirm ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>

        {/* Error */}
        {errorMessage !== '' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        {/* Save button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSave}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Save new password"
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Save Password</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.note}>
          {isFirstLogin
            ? 'You cannot skip this step. This keeps your account secure.'
            : 'Use at least 6 characters for your new password.'}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#FFFFFF' },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 48,
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
  buttonDisabled: { opacity: 0.6 },
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
