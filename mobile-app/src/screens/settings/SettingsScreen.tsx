import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Linking,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import { MainStackParamList } from '../../navigation/AppNavigator';

const PRIVACY_URL = 'https://eduvo.in/privacy-policy';
const TERMS_URL = 'https://eduvo.in/terms-of-service';

// ── Row component ─────────────────────────────────────────────────────────────

function SettingsRow({
  icon,
  label,
  onPress,
  danger,
  value,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  danger?: boolean;
  value?: string;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {!danger && <Text style={styles.rowArrow}>›</Text>}
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const student = useAuthStore((s) => s.student);
  const logout = useAuthStore((s) => s.logout);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const navigation = useNavigation<StackNavigationProp<MainStackParamList>>();

  const activeStudent =
    linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: () => logout(),
        },
      ]
    );
  };

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Profile header */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {activeStudent?.name?.charAt(0)?.toUpperCase() ?? '?'}
            </Text>
          </View>
          <View>
            <Text style={styles.profileName}>{activeStudent?.name ?? '—'}</Text>
            <Text style={styles.profileMeta}>
              {activeStudent?.class
                ? `Class ${activeStudent.class} ${activeStudent.section}`
                : ''}
            </Text>
          </View>
        </View>

        {/* Account section */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="🔑"
            label="Change Password"
            onPress={() => navigation.navigate('ChangePassword')}
          />
          <SettingsRow
            icon="👶"
            label="Link Another Child"
            onPress={() => navigation.navigate('LinkChild')}
          />
        </View>

        {/* Preferences section */}
        <Text style={styles.sectionLabel}>Preferences</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="🔔"
            label="Notification Preferences"
            onPress={() => {}}
            value="Coming soon"
          />
        </View>

        {/* Legal section */}
        <Text style={styles.sectionLabel}>Legal</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="🔒"
            label="Privacy Policy"
            onPress={() => Linking.openURL(PRIVACY_URL)}
          />
          <SettingsRow
            icon="📄"
            label="Terms of Service"
            onPress={() => Linking.openURL(TERMS_URL)}
          />
        </View>

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>

        <Text style={styles.version}>Eduvo v1.0.0</Text>
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    gap: 16,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: 24, fontWeight: '700', color: '#1D4ED8' },
  profileName: { fontSize: 18, fontWeight: '700', color: '#111827' },
  profileMeta: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  rowIcon: { fontSize: 18, marginRight: 14 },
  rowLabel: { flex: 1, fontSize: 15, color: '#111827', fontWeight: '500' },
  rowLabelDanger: { color: '#EF4444' },
  rowValue: { fontSize: 13, color: '#9CA3AF', marginRight: 8 },
  rowArrow: { fontSize: 20, color: '#D1D5DB' },
  logoutButton: {
    backgroundColor: '#FEF2F2',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FECACA',
    marginBottom: 16,
  },
  logoutText: { fontSize: 16, fontWeight: '700', color: '#EF4444' },
  version: { fontSize: 12, color: '#D1D5DB', textAlign: 'center' },
});
