import React from 'react';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';

import { useAuthStore } from '../store/authStore';

// Auth screens
import LoginScreen from '../screens/auth/LoginScreen';
import ChangePasswordScreen from '../screens/auth/ChangePasswordScreen';

// Main screens
import DashboardScreen from '../screens/main/DashboardScreen';
import AttendanceScreen from '../screens/main/AttendanceScreen';
import MarksScreen from '../screens/main/MarksScreen';
import TimetableScreen from '../screens/main/TimetableScreen';
import HomeworkScreen from '../screens/main/HomeworkScreen';
import TestsScreen from '../screens/main/TestsScreen';
import ComplaintsScreen from '../screens/main/ComplaintsScreen';
import NotificationsScreen from '../screens/main/NotificationsScreen';
import TestAttemptScreen, { TestMeta } from '../screens/main/TestAttemptScreen';

// More home screen
import MoreHomeScreen from '../screens/main/MoreHomeScreen';

// Settings screens
import SettingsScreen from '../screens/settings/SettingsScreen';
import LinkChildScreen from '../screens/settings/LinkChildScreen';

// ── Stack param lists ─────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Login: undefined;
  ChangePassword: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Attendance: undefined;
  Marks: undefined;
  More: undefined;
};

export type MainStackParamList = {
  MainTabs: undefined;
  TestAttempt: { test: TestMeta };
  ChangePassword: undefined;
  LinkChild: undefined;
};

// ── Student navigator types (reuse main for now) ──────────────────────────────

export type StudentTabParamList = {
  Home: undefined;
  Attendance: undefined;
  Marks: undefined;
  Tests: undefined;
  More: undefined;
};

export type StudentStackParamList = {
  StudentTabs: undefined;
  TestAttempt: { test: TestMeta };
  ChangePassword: undefined;
};

// ── Parent navigator types ────────────────────────────────────────────────────

export type ParentTabParamList = {
  Dashboard: undefined;
  Attendance: undefined;
  Performance: undefined;
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
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
      <MoreStack.Screen
        name="Timetable"
        component={TimetableScreen}
        options={{ title: 'Timetable' }}
      />
      <MoreStack.Screen
        name="Homework"
        component={HomeworkScreen}
        options={{ title: 'Homework' }}
      />
      <MoreStack.Screen
        name="Tests"
        component={TestsScreen}
        options={{ title: 'Tests' }}
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
        name="More"
        component={MoreNavigator}
        options={{
          headerShown: false,
          title: 'More',
          tabBarIcon: ({ focused }) => <TabIcon label="☰" focused={focused} />,
        }}
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
          headerTitle: 'Link Another Child',
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
    <NavigationContainer ref={navigationRef}>
      {isLoggedIn ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
