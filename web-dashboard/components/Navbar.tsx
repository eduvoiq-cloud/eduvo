'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { schoolsApi } from '@/lib/api';
import { getToken } from '@/lib/session';
import type { AppRole } from '@/lib/api';

// ── Nav items per role ────────────────────────────────────────────────────────

type NavItem = { label: string; href: string };
type NavGroup = { label: string; children: NavItem[] };
type NavEntry = NavItem | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

const NAV_ITEMS: Record<AppRole, NavEntry[]> = {
  superadmin: [
    { label: 'Dashboard', href: '/superadmin/dashboard' },
    { label: 'Schools', href: '/superadmin/schools' },
    { label: 'Users', href: '/superadmin/users' },
    { label: 'Revenue', href: '/superadmin/revenue' },
    { label: 'Audit Logs', href: '/superadmin/audit-logs' },
  ],
  schooladmin: [
    { label: 'Dashboard', href: '/admin/dashboard' },
    {
      label: 'People',
      children: [
        { label: 'Teachers', href: '/admin/teachers' },
        { label: 'Students', href: '/admin/students' },
      ],
    },
    {
      label: 'Academics',
      children: [
        { label: 'Marks', href: '/admin/marks' },
        { label: 'Attendance', href: '/admin/attendance' },
        { label: 'Performance', href: '/admin/performance' },
      ],
    },
    {
      label: 'School',
      children: [
        { label: 'Announcements', href: '/admin/announcements' },
        { label: 'Complaints', href: '/admin/complaints' },
        { label: 'AI Insights', href: '/admin/premium-insights' },
        { label: 'Streak Board', href: '/admin/streak-leaderboard' },
        { label: 'Premium', href: '/admin/premium-management' },
        { label: 'Settings', href: '/admin/settings' },
      ],
    },
  ],
  teacher: [
    { label: 'Dashboard', href: '/teacher/dashboard' },
    {
      label: 'Academics',
      children: [
        { label: 'Marks', href: '/teacher/marks' },
        { label: 'View Marks', href: '/teacher/marks/view' },
        { label: 'Tests', href: '/teacher/tests' },
        { label: 'Daily Test', href: '/teacher/daily-test' },
        { label: 'Homework', href: '/teacher/homework' },
        { label: 'Activity Packs', href: '/teacher/activity-packs' },
        { label: 'Timetable', href: '/teacher/timetable' },
      ],
    },
    {
      label: 'Students',
      children: [
        { label: 'Attendance', href: '/teacher/attendance' },
        { label: 'Fees', href: '/teacher/fees' },
        { label: 'Complaints', href: '/teacher/complaints' },
      ],
    },
    {
      label: 'Tools',
      children: [
        { label: 'AI Assistant', href: '/teacher/ai-assistant' },
        { label: 'Streak Board', href: '/teacher/streak-leaderboard' },
        { label: 'Announcements', href: '/teacher/announcements' },
        { label: 'Premium', href: '/teacher/premium' },
      ],
    },
  ],
  parent: [],
  student: [],
};

// ── Dropdown nav item ─────────────────────────────────────────────────────────

function NavDropdown({ group, pathname }: { group: NavGroup; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Is any child active?
  const hasActiveChild = group.children.some(
    (c) => pathname === c.href || pathname.startsWith(c.href + '/')
  );

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          hasActiveChild
            ? 'bg-blue-50 text-blue-700'
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
        }`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {group.label}
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-44 bg-white rounded-xl border border-gray-200 shadow-lg py-1 z-50">
          {group.children.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`block px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Role badge colours ────────────────────────────────────────────────────────

const ROLE_BADGE: Record<AppRole, string> = {
  superadmin: 'bg-purple-100 text-purple-700',
  schooladmin: 'bg-blue-100 text-blue-700',
  teacher: 'bg-green-100 text-green-700',
  parent: 'bg-yellow-100 text-yellow-700',
  student: 'bg-gray-100 text-gray-700',
};

const ROLE_LABEL: Record<AppRole, string> = {
  superadmin: 'Super Admin',
  schooladmin: 'School Admin',
  teacher: 'Teacher',
  parent: 'Parent',
  student: 'Student',
};

// ── Medium Switcher ───────────────────────────────────────────────────────────

function MediumSwitcher() {
  const { schools, activeSchoolId, switchMedium } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Only render for schooladmin with 2+ schools
  if (!schools || schools.length < 2) return null;

  const active = schools.find((s) => s.id === activeSchoolId) ?? schools[0];

  const mediumLabel = (m: string) =>
    m.charAt(0).toUpperCase() + m.slice(1) + ' Medium';

  const mediumColors = (m: string) =>
    m === 'gujarati'
      ? 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100'
      : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100';

  const activePillColors = (m: string) =>
    m === 'gujarati'
      ? 'bg-orange-50 text-orange-700 border border-orange-200'
      : 'bg-blue-50 text-blue-700 border border-blue-200';

  return (
    <div ref={ref} className="relative hidden sm:block">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${activePillColors(active.medium)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{mediumLabel(active.medium)}</span>
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1.5 w-44 bg-white rounded-xl border border-gray-200 shadow-lg py-1 z-50"
          role="listbox"
        >
          {schools.map((s) => (
            <button
              key={s.id}
              role="option"
              aria-selected={s.id === active.id}
              onClick={() => { switchMedium(s.id); setOpen(false); }}
              className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium transition-colors ${mediumColors(s.medium)}`}
            >
              <span>{mediumLabel(s.medium)}</span>
              {s.id === active.id && (
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [schoolName, setSchoolName] = useState<string | null>(null);

  // Fetch the school name for roles that belong to a school
  useEffect(() => {
    const rolesWithSchool: AppRole[] = ['schooladmin', 'teacher'];
    if (!user || !user.school_id || !rolesWithSchool.includes(user.role)) return;

    const token = getToken();
    if (!token) return;

    schoolsApi.get(token, user.school_id)
      .then((res) => setSchoolName(res.data.name))
      .catch(() => { /* silently ignore — school name is decorative */ });
  }, [user]);

  if (!user) return null;

  const navItems = NAV_ITEMS[user.role] ?? [];

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo + school name + desktop nav */}
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <Image
                src="/logo.png"
                alt="Eduvo"
                width={32}
                height={32}
                className="rounded-lg"
                priority
              />
              <span className="text-gray-900 font-semibold text-lg tracking-tight">
                eduvo
              </span>
            </Link>

            {/* School name badge — only shown for schooladmin and teacher */}
            {schoolName && (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 text-xs font-semibold tracking-wide">
                <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l9-9 9 9M5 10v9a1 1 0 001 1h4v-4h4v4h4a1 1 0 001-1v-9" />
                </svg>
                {schoolName}
              </span>
            )}

            {/* Desktop nav links */}
            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((entry) => {
                if (isNavGroup(entry)) {
                  return <NavDropdown key={entry.label} group={entry} pathname={pathname} />;
                }
                const active = pathname === entry.href || pathname.startsWith(entry.href + '/');
                return (
                  <Link
                    key={entry.href}
                    href={entry.href}
                    className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                  >
                    {entry.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Medium switcher — only visible for schooladmin with 2 mediums */}
            <MediumSwitcher />

            <span className={`hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[user.role]}`}>
              {ROLE_LABEL[user.role]}
            </span>
            <span className="hidden sm:block text-sm text-gray-700 font-medium truncate max-w-[140px]">
              {user.name}
            </span>
            <button
              onClick={logout}
              className="hidden sm:block text-sm text-gray-500 hover:text-red-600 px-3 py-1.5 rounded-md border border-gray-200 hover:border-red-200 transition-colors"
            >
              Logout
            </button>

            {/* Mobile hamburger */}
            {navItems.length > 0 && (
              <button
                onClick={() => setMobileOpen((v) => !v)}
                className="md:hidden p-2 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && navItems.length > 0 && (
        <div className="md:hidden border-t border-gray-100 bg-white">
          <nav className="px-4 py-3 space-y-1">
            {/* School name in mobile menu */}
            {schoolName && (
              <div className="flex items-center gap-1.5 px-3 py-2 mb-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold">
                <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l9-9 9 9M5 10v9a1 1 0 001 1h4v-4h4v4h4a1 1 0 001-1v-9" />
                </svg>
                {schoolName}
              </div>
            )}

            {/* Mobile medium switcher */}
            <MobileMediumSwitcher onClose={() => setMobileOpen(false)} />

            {navItems.map((entry) => {
              if (isNavGroup(entry)) {
                return (
                  <div key={entry.label}>
                    <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                      {entry.label}
                    </p>
                    {entry.children.map((item) => {
                      const active = pathname === item.href || pathname.startsWith(item.href + '/');
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setMobileOpen(false)}
                          className={`block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                            active
                              ? 'bg-blue-50 text-blue-700'
                              : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                );
              }
              const active = pathname === entry.href || pathname.startsWith(entry.href + '/');
              return (
                <Link
                  key={entry.href}
                  href={entry.href}
                  onClick={() => setMobileOpen(false)}
                  className={`block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {entry.label}
                </Link>
              );
            })}
            <div className="pt-2 border-t border-gray-100 mt-2">
              <div className="flex items-center justify-between px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{user.name}</p>
                  <p className={`text-xs font-medium mt-0.5 ${ROLE_BADGE[user.role].split(' ')[1]}`}>
                    {ROLE_LABEL[user.role]}
                  </p>
                </div>
                <button
                  onClick={() => { setMobileOpen(false); logout(); }}
                  className="text-sm text-red-600 font-medium px-3 py-1.5 rounded-md border border-red-200 hover:bg-red-50 transition-colors"
                >
                  Logout
                </button>
              </div>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

// ── Mobile Medium Switcher ────────────────────────────────────────────────────

function MobileMediumSwitcher({ onClose }: { onClose: () => void }) {
  const { schools, activeSchoolId, switchMedium } = useAuth();

  if (!schools || schools.length < 2) return null;

  const mediumLabel = (m: string) =>
    m.charAt(0).toUpperCase() + m.slice(1) + ' Medium';

  return (
    <div className="flex gap-2 px-1 pb-1">
      {schools.map((s) => {
        const isActive = s.id === (activeSchoolId ?? schools[0].id);
        return (
          <button
            key={s.id}
            onClick={() => { switchMedium(s.id); onClose(); }}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
              isActive
                ? s.medium === 'gujarati'
                  ? 'bg-orange-100 text-orange-700 border-orange-300'
                  : 'bg-blue-100 text-blue-700 border-blue-300'
                : 'bg-gray-50 text-gray-500 border-gray-200'
            }`}
          >
            {mediumLabel(s.medium)}
          </button>
        );
      })}
    </div>
  );
}
