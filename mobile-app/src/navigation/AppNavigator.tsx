import React from 'react';
import { Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { useAuthStore } from '../store/authStore';

// Auth screens
import LoginScreen from '../screens/auth/LoginScreen';
import ChangePasswordScreen from '../screens/auth/ChangePasswordScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import OTPVerificationScreen from '../screens/auth/OTPVerificationScreen';

// Main screens (used by students)
import DashboardScreen from '../screens/main/DashboardScreen';
import AttendanceScreen from '../screens/main/AttendanceScreen';
import MarksScreen from '../screens/main/MarksScreen';
import TimetableScreen from '../screens/main/TimetableScreen';
import HomeworkScreen from '../screens/main/HomeworkScreen';
import ResourcesScreen from '../screens/main/ResourcesScreen';
import ComplaintsScreen from '../screens/main/ComplaintsScreen';
import NotificationsScreen from '../screens/main/NotificationsScreen';
import FeeStatusScreen from '../screens/main/FeeStatusScreen';
import TestAttemptScreen, { TestMeta } from '../screens/main/TestAttemptScreen';

// Student-specific screens
import StudentTestsScreen from '../screens/main/TestsScreen';
import HomeworkSubmitScreen, { type HomeworkMeta } from '../screens/student/HomeworkSubmitScreen';
import RecoveryPacksScreen from '../screens/student/RecoveryPacksScreen';
import RecoveryPackDetailScreen from '../screens/student/RecoveryPackDetailScreen';
import MonthlyRecoveryTestsScreen from '../screens/student/RecoveryTestListScreen';
import MonthlyRecoveryTestAttemptScreen from '../screens/student/RecoveryTestAttemptScreen';
import ReportCardsScreen from '../screens/student/ReportCardsScreen';

// More home screen
import MoreHomeScreen from '../screens/main/MoreHomeScreen';

// Announcements screen
import AnnouncementsScreen from '../screens/main/AnnouncementsScreen';

// Settings screens
import SettingsScreen from '../screens/settings/SettingsScreen';
import LinkChildScreen from '../screens/settings/LinkChildScreen';

// NOTE: Parent screens (src/screens/parent/) are kept on disk but are no longer
// routed through a separate ParentNavigator. Parents log in with their child's
// phone number and use the same student UI. The childStore handles switching
// between linked children inside the existing student screens.

// ── Stack param lists ─────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Login: undefined;
  ChangePassword: undefined;
  ForgotPassword: undefined;
  OTPVerification: { phone: string };
};

export type MainTabParamList = {
  Home: undefined;
  Attendance: undefined;
  Marks: undefined;
  Tests: undefined;
  More: undefined;
};

// Alias for backwards compatibility
export type StudentTabParamList = MainTabParamList;

export type MainStackParamList = {
  MainTabs: undefined;
  TestAttempt: { test: TestMeta };
  HomeworkModal: undefined;
  HomeworkSubmit: { homework: HomeworkMeta };
  NotificationsModal: undefined;
  Resources: undefined;
  ChangePassword: undefined;
  LinkChild: undefined;
  Announcements: undefined;
  RecoveryPacks: undefined;
  RecoveryPackDetail: { packId: string; isCycle?: boolean };
  MonthlyRecoveryTests: { cycleId?: string } | undefined;
  MonthlyRecoveryTestAttempt: { testId: string };
  ReportCards: undefined;
};

// Keep StudentStackParamList as an alias so existing student screens don't break
export type StudentStackParamList = MainStackParamList;

// ParentTabParamList is kept for TypeScript compatibility — the parent screens
// still exist on disk and import this type. They are not actively routed to;
// parents use the standard student UI (with child switching via childStore).
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

// ── Tab icon helper ───────────────────────────────────────────────────────────

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{label}</Text>
  );
}

// ── Auth navigator ────────────────────────────────────────────────────────────

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="ChangePassword" component={ChangePasswordScreen} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <AuthStack.Screen name="OTPVerification" component={OTPVerificationScreen} />
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
        name="Resources"
        component={ResourcesScreen}
        options={{ title: 'Notes & Resources' }}
      />
      <MoreStack.Screen
        name="HomeworkSubmit"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={HomeworkSubmitScreen as React.ComponentType<any>}
        options={{ title: 'Submit Homework' }}
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
      <MoreStack.Screen
        name="ReportCards"
        component={ReportCardsScreen}
        options={{ title: 'Report Cards' }}
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
        name="HomeworkModal"
        component={HomeworkScreen}
        options={{
          headerShown: true,
          headerTitle: 'Homework',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="NotificationsModal"
        component={NotificationsScreen}
        options={{
          headerShown: true,
          headerTitle: 'Notifications',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="TestAttempt"
        component={TestAttemptScreen}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="HomeworkSubmit"
        component={HomeworkSubmitScreen}
        options={{
          headerShown: true,
          headerTitle: 'Submit Homework',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="Resources"
        component={ResourcesScreen}
        options={{
          headerShown: true,
          headerTitle: 'Notes & Resources',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
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
      <MainStack.Screen
        name="RecoveryPacks"
        component={RecoveryPacksScreen}
        options={{
          headerShown: true,
          headerTitle: 'Recovery Packs',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="RecoveryPackDetail"
        component={RecoveryPackDetailScreen}
        options={{
          headerShown: true,
          headerTitle: 'Recovery Pack',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="MonthlyRecoveryTests"
        component={MonthlyRecoveryTestsScreen}
        options={{
          headerShown: true,
          headerTitle: 'Recovery Tests',
          headerStyle: { backgroundColor: '#1D4ED8' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />
      <MainStack.Screen
        name="MonthlyRecoveryTestAttempt"
        component={MonthlyRecoveryTestAttemptScreen}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="ReportCards"
        component={ReportCardsScreen}
        options={{
          headerShown: true,
          headerTitle: 'Report Cards',
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
  navigationRef?: React.RefObject<NavigationContainerRef<any>>;
}

export default function AppNavigator({ navigationRef }: AppNavigatorProps) {
  const { isLoggedIn } = useAuthStore();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationContainer ref={navigationRef}>
        {isLoggedIn ? <MainNavigator /> : <AuthNavigator />}
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}
