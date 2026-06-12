import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { useAuthStore } from '../store/authStore';

// Auth screens
import LoginScreen from '../screens/auth/LoginScreen';
import ChangePasswordScreen from '../screens/auth/ChangePasswordScreen';

// Main screens (used by students)
import DashboardScreen from '../screens/main/DashboardScreen';
import AttendanceScreen from '../screens/main/AttendanceScreen';
import MarksScreen from '../screens/main/MarksScreen';
import TimetableScreen from '../screens/main/TimetableScreen';
import HomeworkScreen from '../screens/main/HomeworkScreen';
import ComplaintsScreen from '../screens/main/ComplaintsScreen';
import NotificationsScreen from '../screens/main/NotificationsScreen';
import FeeStatusScreen from '../screens/main/FeeStatusScreen';
import TestAttemptScreen, { TestMeta } from '../screens/main/TestAttemptScreen';

// Student-specific screens
import StudentTestsScreen from '../screens/student/TestsScreen';
import DailyTestScreen from '../screens/student/DailyTestScreen';
import DailyTestAttemptScreen from '../screens/student/DailyTestAttemptScreen';
import type { DailyTestMeta } from '../screens/student/DailyTestScreen';

// More home screen
import MoreHomeScreen from '../screens/main/MoreHomeScreen';

// Announcements screen
import AnnouncementsScreen from '../screens/main/AnnouncementsScreen';

// Settings screens
import SettingsScreen from '../screens/settings/SettingsScreen';
import LinkChildScreen from '../screens/settings/LinkChildScreen';

// Parent screens
import ParentDashboardScreen from '../screens/parent/DashboardScreen';
import ParentAttendanceScreen from '../screens/parent/AttendanceScreen';
import ParentPerformanceScreen from '../screens/parent/PerformanceScreen';
import ParentNotificationsScreen from '../screens/parent/NotificationsScreen';
import ActivityPacksScreen from '../screens/parent/ActivityPacksScreen';
import PremiumInsightsScreen from '../screens/parent/PremiumInsightsScreen';

import { useChildStore } from '../store/childStore';

// ── Stack param lists ─────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Login: undefined;
  ChangePassword: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Attendance: undefined;
  Marks: undefined;
  Tests: undefined;
  DailyTest: undefined;
  More: undefined;
};

// Alias for backwards compatibility
export type StudentTabParamList = MainTabParamList;

export type MainStackParamList = {
  MainTabs: undefined;
  TestAttempt: { test: TestMeta };
  DailyTestAttempt: { test: DailyTestMeta };
  ChangePassword: undefined;
  LinkChild: undefined;
  Announcements: undefined;
};

// Keep StudentStackParamList as an alias so existing student screens don't break
export type StudentStackParamList = MainStackParamList;

// ── Parent navigator types ────────────────────────────────────────────────────

export type ParentTabParamList = {
  Dashboard: undefined;
  Attendance: undefined;
  ActivityPacks: undefined;
  Performance: undefined;
  Insights: undefined;
  Notifications: undefined;
};

// ── Navigators ────────────────────────────────────────────────────────────────

const AuthStack = createStackNavigator<AuthStackParamList>();
const MainTab = createBottomTabNavigator<MainTabParamList>();
const MainStack = createStackNavigator<MainStackParamList>();
const ParentTab = createBottomTabNavigator<ParentTabParamList>();

// ── Tab icon helper ───────────────────────────────────────────────────────────

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{label}</Text>
  );
}

// ── Subscription expired screen ───────────────────────────────────────────────

function SubscriptionExpiredScreen() {
  const logout = useAuthStore((s) => s.logout);
  return (
    <View style={styles.expiredContainer}>
      <View style={styles.expiredCard}>
        <Text style={styles.expiredIcon}>⚠️</Text>
        <Text style={styles.expiredTitle}>Subscription Expired</Text>
        <Text style={styles.expiredMessage}>
          Your school&apos;s subscription has expired. Please ask your school
          administrator to renew the subscription to continue using the service.
        </Text>
        <TouchableOpacity style={styles.expiredButton} onPress={logout}>
          <Text style={styles.expiredButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  expiredContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  expiredCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  expiredIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  expiredTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
    textAlign: 'center',
  },
  expiredMessage: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  expiredButton: {
    backgroundColor: '#1D4ED8',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
  },
  expiredButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});

// ── Parent bottom tab navigator ───────────────────────────────────────────────

function ParentNavigator() {
  return (
    <ParentTab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#1D4ED8' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#1D4ED8',
        tabBarInactiveTintColor: '#9CA3AF',
        tabBarStyle: { paddingBottom: 4 },
      }}
    >
      <ParentTab.Screen
        name="Dashboard"
        component={ParentDashboardScreen}
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon label="🏠" focused={focused} />,
        }}
      />
      <ParentTab.Screen
        name="Attendance"
        component={ParentAttendanceScreen}
        options={{
          title: 'Attendance',
          tabBarIcon: ({ focused }) => <TabIcon label="📅" focused={focused} />,
        }}
      />
      <ParentTab.Screen
        name="ActivityPacks"
        component={ActivityPacksScreen}
        options={{
          title: 'Activities',
          tabBarIcon: ({ focused }) => <TabIcon label="🎯" focused={focused} />,
          headerTitle: "Today's Activities",
        }}
      />
      <ParentTab.Screen
        name="Performance"
        component={ParentPerformanceScreen}
        options={{
          title: 'Progress',
          tabBarIcon: ({ focused }) => <TabIcon label="📊" focused={focused} />,
        }}
      />
      <ParentTab.Screen
        name="Insights"
        component={PremiumInsightsScreen}
        options={{
          title: 'Insights',
          tabBarIcon: ({ focused }) => <TabIcon label="✨" focused={focused} />,
          headerShown: false,
        }}
      />
      <ParentTab.Screen
        name="Notifications"
        component={ParentNotificationsScreen}
        options={{
          title: 'Alerts',
          tabBarIcon: ({ focused }) => <TabIcon label="🔔" focused={focused} />,
        }}
      />
    </ParentTab.Navigator>
  );
}

// ── Auth navigator ────────────────────────────────────────────────────────────

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="ChangePassword" component={ChangePasswordScreen} />
    </AuthStack.Navigator>
  );
}

// ── "More" stack — groups secondary screens under the More tab ────────────────

const MoreStack = createStackNavigator();

function MoreNavigator() {
  return (
    <MoreStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#1D4ED8' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <MoreStack.Screen
        name="MoreHome"
        component={MoreHomeScreen}
        options={{ title: 'More' }}
      />
      <MoreStack.Screen
        name="Complaints"
        component={ComplaintsScreen}
        options={{ title: 'Complaints' }}
      />
      <MoreStack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ title: 'Notifications' }}
      />
      <MoreStack.Screen
        name="Announcements"
        component={AnnouncementsScreen}
        options={{ title: 'Announcements' }}
      />
      <MoreStack.Screen
        name="FeeStatus"
        component={FeeStatusScreen}
        options={{ title: 'Fee Remaining' }}
      />
      <MoreStack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ title: 'Change Password' }}
      />
      <MoreStack.Screen
        name="LinkChild"
        component={LinkChildScreen}
        options={{ title: 'Link Another Student' }}
      />
      <MoreStack.Screen
        name="Homework"
        component={HomeworkScreen}
        options={{ title: 'Homework' }}
      />
      <MoreStack.Screen
        name="Timetable"
        component={TimetableScreen}
        options={{ title: 'Timetable' }}
      />
      <MoreStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
    </MoreStack.Navigator>
  );
}

// ── Main bottom tab navigator ─────────────────────────────────────────────────

function MainTabNavigator() {
  return (
    <MainTab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#1D4ED8' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#1D4ED8',
        tabBarInactiveTintColor: '#9CA3AF',
        tabBarStyle: { paddingBottom: 4 },
      }}
    >
      <MainTab.Screen
        name="Home"
        component={DashboardScreen}
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon label="🏠" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="Attendance"
        component={AttendanceScreen}
        options={{
          title: 'Attendance',
          tabBarIcon: ({ focused }) => <TabIcon label="📅" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="Marks"
        component={MarksScreen}
        options={{
          title: 'Marks',
          tabBarIcon: ({ focused }) => <TabIcon label="📊" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="Tests"
        component={StudentTestsScreen}
        options={{
          title: 'Tests',
          tabBarIcon: ({ focused }) => <TabIcon label="📝" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="DailyTest"
        component={DailyTestScreen}
        options={{
          title: 'Daily Test',
          tabBarIcon: ({ focused }) => <TabIcon label="🧠" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="More"
        component={MoreNavigator}
        options={{
          headerShown: false,
          title: 'More',
          tabBarIcon: ({ focused }) => <TabIcon label="☰" focused={focused} />,
        }}
        listeners={({ navigation }) => ({
          tabPress: () => {
            // Always reset the More stack to MoreHome when the tab is tapped
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (navigation as any).navigate('More', { screen: 'MoreHome' });
          },
        })}
      />
    </MainTab.Navigator>
  );
}

// ── Main stack navigator (wraps tabs + modal screens) ────────────────────────

function MainNavigator() {
  const isFirstLogin = useAuthStore((s) => s.isFirstLogin);

  return (
    <MainStack.Navigator
      screenOptions={{ headerShown: false }}
      initialRouteName={isFirstLogin ? 'ChangePassword' : 'MainTabs'}
    >
      <MainStack.Screen name="MainTabs" component={MainTabNavigator} />
      <MainStack.Screen
        name="TestAttempt"
        component={TestAttemptScreen}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="DailyTestAttempt"
        component={DailyTestAttemptScreen}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{
          headerShown: false,
          gestureEnabled: false,
        }}
      />
      <MainStack.Screen
        name="LinkChild"
        component={LinkChildScreen}
        options={{
          headerShown: true,
          headerTitle: 'Link Another Student',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
    </MainStack.Navigator>
  );
}

// ── Root navigator ────────────────────────────────────────────────────────────

interface AppNavigatorProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigationRef?: React.RefObject<NavigationContainerRef<any> | null>;
}

export default function AppNavigator({ navigationRef }: AppNavigatorProps) {
  const { isLoggedIn, subscriptionExpired } = useAuthStore();
  const linkedChildren = useChildStore((s) => s.linkedChildren);
  const isParent = linkedChildren.length > 0;

  return (
    <NavigationContainer ref={navigationRef}>
      {isLoggedIn && subscriptionExpired
        ? <SubscriptionExpiredScreen />
        : isLoggedIn && isParent
        ? <ParentNavigator />
        : isLoggedIn
        ? <MainNavigator />
        : <AuthNavigator />}
    </NavigationContainer>
  );
}
