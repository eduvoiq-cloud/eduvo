import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';

// ── Types ─────────────────────────────────────────────────────────────────────

type MoreStackParamList = {
  MoreHome: undefined;
  Homework: undefined;
  Tests: undefined;
  Timetable: undefined;
  Notifications: undefined;
  Complaints: undefined;
  Settings: undefined;
};

type MoreNavProp = StackNavigationProp<MoreStackParamList>;

// ── Menu item component ───────────────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  description,
  color,
  onPress,
}: {
  icon: string;
  label: string;
  description: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.menuItem}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.menuIconBox, { backgroundColor: color + '20' }]}>
        <Text style={styles.menuIcon}>{icon}</Text>
      </View>
      <View style={styles.menuText}>
        <Text style={styles.menuLabel}>{label}</Text>
        <Text style={styles.menuDesc}>{description}</Text>
      </View>
      <Text style={styles.menuArrow}>›</Text>
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MoreHomeScreen() {
  const navigation = useNavigation<MoreNavProp>();

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>Academics</Text>
        <View style={styles.section}>
          <MenuItem
            icon="📚"
            label="Homework"
            description="View and track pending homework"
            color="#F59E0B"
            onPress={() => navigation.navigate('Homework')}
          />
          <MenuItem
            icon="📝"
            label="Tests"
            description="Upcoming and past tests"
            color="#8B5CF6"
            onPress={() => navigation.navigate('Tests')}
          />
          <MenuItem
            icon="🗓️"
            label="Timetable"
            description="Your weekly class schedule"
            color="#1D4ED8"
            onPress={() => navigation.navigate('Timetable')}
          />
        </View>

        <Text style={styles.sectionLabel}>Communication</Text>
        <View style={styles.section}>
          <MenuItem
            icon="🔔"
            label="Notifications"
            description="Alerts and school announcements"
            color="#22C55E"
            onPress={() => navigation.navigate('Notifications')}
          />
          <MenuItem
            icon="💬"
            label="Complaints"
            description="Raise or track a complaint"
            color="#EF4444"
            onPress={() => navigation.navigate('Complaints')}
          />
        </View>

        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <MenuItem
            icon="⚙️"
            label="Settings"
            description="Password, linked children & more"
            color="#6B7280"
            onPress={() => navigation.navigate('Settings')}
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
  menuDesc: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  menuArrow: { fontSize: 20, color: '#D1D5DB' },
});
