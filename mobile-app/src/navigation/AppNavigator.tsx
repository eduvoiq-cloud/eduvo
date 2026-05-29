import React from 'react';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';

import { useAuthStore } from '../store/authStore';

// Auth screens
import LoginScreen from '../screens/auth/LoginScreen';

// Parent screens
import ParentDashboardScreen from '../screens/parent/DashboardScreen';
import ParentAttendanceScreen from '../screens/parent/AttendanceScreen';
import ParentNotificationsScreen from '../screens/parent/NotificationsScreen';
import ParentPerformanceScreen from '../screens/parent/PerformanceScreen';

// Student screens
import StudentDashboardScreen from '../screens/student/DashboardScreen';
import StudentMarksScreen from '../screens/student/MarksScreen';
import StudentTestsScreen from '../screens/student/TestsScreen';
import TestAttemptScreen, { TestMeta } from '../screens/student/TestAttemptScreen';

// ── Stack param lists ─────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Login: undefined;
};

export type ParentTabParamList = {
  Dashboard: undefined;
  Attendance: undefined;
  Notifications: undefined;
  Performance: undefined;
};

export type StudentTabParamList = {
  Dashboard: undefined;
  Marks: undefined;
  Tests: undefined;
};

export type StudentStackParamList = {
  StudentTabs: undefined;
  TestAttempt: { test: TestMeta };
};

// ── Navigators ────────────────────────────────────────────────────────────────

const AuthStack = createStackNavigator<AuthStackParamList>();
const ParentTab = createBottomTabNavigator<ParentTabParamList>();
const StudentTab = createBottomTabNavigator<StudentTabParamList>();
const StudentStack = createStackNavigator<StudentStackParamList>();

// ── Tab icon helper (text-based, no icon library dependency) ──────────────────
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
    </AuthStack.Navigator>
  );
}

// ── Parent tab navigator ──────────────────────────────────────────────────────
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
        name="Notifications"
        component={ParentNotificationsScreen}
        options={{
          title: 'Notifications',
          tabBarIcon: ({ focused }) => <TabIcon label="🔔" focused={focused} />,
        }}
      />
      <ParentTab.Screen
        name="Performance"
        component={ParentPerformanceScreen}
        options={{
          title: 'Performance',
          tabBarIcon: ({ focused }) => <TabIcon label="📈" focused={focused} />,
        }}
      />
    </ParentTab.Navigator>
  );
}

// ── Student tab navigator ─────────────────────────────────────────────────────
function StudentTabNavigator() {
  return (
    <StudentTab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#1D4ED8' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#1D4ED8',
        tabBarInactiveTintColor: '#9CA3AF',
        tabBarStyle: { paddingBottom: 4 },
      }}
    >
      <StudentTab.Screen
        name="Dashboard"
        component={StudentDashboardScreen}
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon label="🏠" focused={focused} />,
        }}
      />
      <StudentTab.Screen
        name="Marks"
        component={StudentMarksScreen}
        options={{
          title: 'Marks',
          tabBarIcon: ({ focused }) => <TabIcon label="📊" focused={focused} />,
        }}
      />
      <StudentTab.Screen
        name="Tests"
        component={StudentTestsScreen}
        options={{
          title: 'Tests',
          tabBarIcon: ({ focused }) => <TabIcon label="📝" focused={focused} />,
        }}
      />
    </StudentTab.Navigator>
  );
}

function StudentNavigator() {
  return (
    <StudentStack.Navigator screenOptions={{ headerShown: false }}>
      <StudentStack.Screen name="StudentTabs" component={StudentTabNavigator} />
      <StudentStack.Screen
        name="TestAttempt"
        component={TestAttemptScreen}
        options={{ headerShown: false }}
      />
    </StudentStack.Navigator>
  );
}

// ── Root navigator ────────────────────────────────────────────────────────────
interface AppNavigatorProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigationRef?: React.RefObject<NavigationContainerRef<any>>;
}

export default function AppNavigator({ navigationRef }: AppNavigatorProps) {
  const { isLoggedIn, user } = useAuthStore();

  const renderNavigator = () => {
    if (!isLoggedIn || !user) {
      return <AuthNavigator />;
    }

    switch (user.role) {
      case 'parent':
        return <ParentNavigator />;
      case 'student':
        return <StudentNavigator />;
      default:
        // Roles not supported on mobile (superadmin, schooladmin, teacher)
        // Logout and show login screen
        return <AuthNavigator />;
    }
  };

  return (
    <NavigationContainer ref={navigationRef}>
      {renderNavigator()}
    </NavigationContainer>
  );
}
