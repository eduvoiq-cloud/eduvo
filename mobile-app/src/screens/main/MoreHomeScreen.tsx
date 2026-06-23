import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useAuthStore } from '../../store/authStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type MoreStackParamList = {
  MoreHome: undefined;
  Homework: undefined;
  Resources: undefined;
  Timetable: undefined;
  Notifications: undefined;
  Announcements: undefined;
  Complaints: undefined;
  FeeStatus: undefined;
  ChangePassword: undefined;
  LinkChild: undefined;
  Settings: undefined;
  RecoveryPacks: undefined;
  MonthlyRecoveryTests: undefined;
  ReportCards: undefined;
  Leaderboard: undefined;
};

type MoreNavProp = StackNavigationProp<MoreStackParamList>;

// ── Menu item component ───────────────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  description,
  color,
  onPress,
  danger,
}: {
  icon: string;
  label: string;
  description: string;
  color: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity
      style={styles.menuItem}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.menuIconBox, { backgroundColor: danger ? '#FEF2F2' : color + '20' }]}>
        <Text style={styles.menuIcon}>{icon}</Text>
      </View>
      <View style={styles.menuText}>
        <Text style={[styles.menuLabel, danger && styles.menuLabelDanger]}>{label}</Text>
        <Text style={styles.menuDesc}>{description}</Text>
      </View>
      {!danger && <Text style={styles.menuArrow}>›</Text>}
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MoreHomeScreen() {
  const navigation = useNavigation<MoreNavProp>();
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log Out', style: 'destructive', onPress: () => logout() },
      ]
    );
  };

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>

        {/* Academics */}
        <Text style={styles.sectionLabel}>Academics</Text>
        <View style={styles.section}>
          <MenuItem
            icon="📖"
            label="Homework"
            description="View and track pending homework"
            color="#F59E0B"
            onPress={() => navigation.navigate('Homework')}
          />
          <MenuItem
            icon="📚"
            label="Notes & Resources"
            description="Notes and assignments uploaded by teachers"
            color="#1D4ED8"
            onPress={() => navigation.navigate('Resources')}
          />
          <MenuItem
            icon="🗓️"
            label="Timetable"
            description="Your weekly class schedule"
            color="#1D4ED8"
            onPress={() => navigation.navigate('Timetable')}
          />
          <MenuItem
            icon="📘"
            label="Recovery Packs"
            description="Personalised study packs for your weak topics"
            color="#7C3AED"
            onPress={() => navigation.navigate('RecoveryPacks')}
          />
          <MenuItem
            icon="🎯"
            label="Recovery Tests"
            description="Monthly tests based on your weak topics"
            color="#7C3AED"
            onPress={() => navigation.navigate('MonthlyRecoveryTests')}
          />
          <MenuItem
            icon="📄"
            label="Report Cards"
            description="View your exam report cards and grades"
            color="#1D4ED8"
            onPress={() => navigation.navigate('ReportCards')}
          />
          <MenuItem
            icon="🏆"
            label="Leaderboard"
            description="See how you rank in your class this month"
            color="#F59E0B"
            onPress={() => navigation.navigate('Leaderboard')}
          />
        </View>

        {/* Communication */}
        <Text style={styles.sectionLabel}>Communication</Text>
        <View style={styles.section}>
          <MenuItem
            icon="📢"
            label="Announcements"
            description="View all school announcements"
            color="#1D4ED8"
            onPress={() => navigation.navigate('Announcements')}
          />
          <MenuItem
            icon="💬"
            label="Complaints"
            description="Raise a complaint to teacher or admin"
            color="#EF4444"
            onPress={() => navigation.navigate('Complaints')}
          />
          <MenuItem
            icon="🔔"
            label="Notifications"
            description="Alerts and school announcements"
            color="#22C55E"
            onPress={() => navigation.navigate('Notifications')}
          />
        </View>

        {/* Fees */}
        <Text style={styles.sectionLabel}>Fees</Text>
        <View style={styles.section}>
          <MenuItem
            icon="💰"
            label="Fee Remaining"
            description="Check your fee balance and payment status"
            color="#8B5CF6"
            onPress={() => navigation.navigate('FeeStatus')}
          />
        </View>

        {/* Account */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <MenuItem
            icon="🔑"
            label="Change Password"
            description="Update your account password"
            color="#6B7280"
            onPress={() => navigation.navigate('ChangePassword')}
          />
          <MenuItem
            icon="👶"
            label="Link Another Student"
            description="Add another student to your account"
            color="#3B82F6"
            onPress={() => navigation.navigate('LinkChild')}
          />
          <MenuItem
            icon="🚪"
            label="Log Out"
            description="Sign out of your account"
            color="#EF4444"
            onPress={handleLogout}
            danger
          />
        </View>

      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
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
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  menuIconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  menuIcon: { fontSize: 20 },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 15, fontWeight: '600', color: '#111827' },
  menuLabelDanger: { color: '#EF4444' },
  menuDesc: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  menuArrow: { fontSize: 20, color: '#D1D5DB' },
});
