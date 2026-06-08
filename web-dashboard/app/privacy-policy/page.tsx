'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

const sections = [
  { id: 'introduction', num: '1', title: 'Introduction' },
  { id: 'data-we-collect', num: '2', title: 'Data We Collect' },
  { id: 'how-we-use', num: '3', title: 'How We Use Your Data' },
  { id: 'legal-basis', num: '4', title: 'Legal Basis for Processing' },
  { id: 'parental-consent', num: '5', title: "Parental Consent & Children's Data" },
  { id: 'data-sharing', num: '6', title: 'Data Sharing' },
  { id: 'data-storage', num: '7', title: 'Data Storage & Security' },
  { id: 'data-retention', num: '8', title: 'Data Retention' },
  { id: 'your-rights', num: '9', title: 'Your Rights Under DPDP Act 2023' },
  { id: 'data-deletion', num: '10', title: 'Data Deletion & Account Closure' },
  { id: 'grievance-officer', num: '11', title: 'Grievance Officer' },
  { id: 'data-breach', num: '12', title: 'Data Breach Notification' },
  { id: 'cookies', num: '13', title: 'Cookies & Tracking' },
  { id: 'third-party-links', num: '14', title: 'Third Party Links' },
  { id: 'changes', num: '15', title: 'Changes to This Policy' },
  { id: 'contact', num: '16', title: 'Contact Us' },
];

export default function PrivacyPolicyPage() {
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    const handleScroll = () => setShowBackToTop(window.scrollY > 400);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      const offset = 80;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen bg-white text-gray-800" style={{ fontSize: '16px' }}>

      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
              <span className="text-white font-bold text-sm">E</span>
            </div>
            <span className="text-gray-900 font-semibold text-lg tracking-tight">eduvo</span>
          </Link>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors"
            aria-label="Print this page"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-4xl mx-auto px-6 py-10 print:py-4">

        {/* Title block */}
        <div className="mb-8 print:mb-4">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Privacy Policy</h1>
          <p className="text-sm text-gray-500 mb-1">
            <span className="font-medium text-gray-700">Last Updated: June 2026</span>
          </p>
          <p className="text-sm text-gray-500 mb-4">
            Effective date: June 2026 &nbsp;·&nbsp; Jurisdiction: India
          </p>
          {/* Hindi notice */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
            <span className="text-blue-500 mt-0.5">🌐</span>
            <span>
              This policy is available in <strong>Hindi</strong> on request. Contact{' '}
              <a href="mailto:eduvoiq@gmail.com" className="underline font-medium hover:text-blue-900">
                eduvoiq@gmail.com
              </a>{' '}
              to receive a Hindi copy.
            </span>
          </div>
        </div>

        {/* ── Table of Contents ── */}
        <nav
          aria-label="Table of contents"
          className="bg-gray-50 border border-gray-200 rounded-2xl p-6 mb-12 print:hidden"
        >
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
            Table of Contents
          </h2>
          <ol className="space-y-2">
            {sections.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollToSection(s.id)}
                  className="text-left text-blue-600 hover:text-blue-800 hover:underline text-sm w-full transition-colors"
                >
                  {s.num}. {s.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {/* ── Sections ── */}
        <div className="space-y-14 leading-relaxed">

          {/* 1. Introduction */}
          <section id="introduction" aria-labelledby="heading-introduction">
            <SectionHeading num="1" title="Introduction" id="heading-introduction" />
            <p className="mb-3">
              Eduvo (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) is a school management platform operated by{' '}
              <strong>Eduvo (eduvoiq@gmail.com)</strong>, based in <strong>Vadodara, Gujarat, India</strong>.
            </p>
            <p className="mb-3">
              We provide attendance tracking, academic performance monitoring, homework management, and school
              communication tools to schools and coaching institutes across India.
            </p>
            <p>
              This Privacy Policy explains how we collect, use, store, and protect personal data in compliance
              with India&rsquo;s <strong>Digital Personal Data Protection Act, 2023 (DPDP Act)</strong>, the{' '}
              <strong>DPDP Rules 2025</strong>, the <strong>Information Technology Act, 2000</strong>, and the{' '}
              <strong>IT (Reasonable Security Practices) Rules, 2011</strong>.
            </p>
          </section>

          {/* 2. Data We Collect */}
          <section id="data-we-collect" aria-labelledby="heading-data-we-collect">
            <SectionHeading num="2" title="Data We Collect" id="heading-data-we-collect" />

            <DataGroup title="For Students (Data Principals)">
              <li>Full name</li>
              <li>Date of birth</li>
              <li>Class and section</li>
              <li>Roll number</li>
              <li>Attendance records</li>
              <li>Academic marks and test results</li>
              <li>Homework acknowledgements</li>
              <li>Parent / guardian phone number</li>
            </DataGroup>

            <DataGroup title="For Parents / Guardians">
              <li>Name</li>
              <li>Phone number (used as login credential)</li>
              <li>Relationship to student</li>
            </DataGroup>

            <DataGroup title="For Teachers and School Staff">
              <li>Full name</li>
              <li>Email address</li>
              <li>Phone number</li>
              <li>Assigned classes and subjects</li>
            </DataGroup>

            <DataGroup title="For Schools">
              <li>School name and address</li>
              <li>Contact details</li>
              <li>Subscription status</li>
            </DataGroup>

            <div className="mt-6 bg-green-50 border border-green-100 rounded-xl px-5 py-4">
              <p className="text-sm font-semibold text-green-800 mb-2">We do NOT collect:</p>
              <ul className="text-sm text-green-700 space-y-1 list-disc list-inside">
                <li>Aadhaar numbers or government IDs</li>
                <li>Bank account or payment details</li>
                <li>Biometric data</li>
                <li>Location / GPS data</li>
                <li>Browsing history or behavioural data</li>
              </ul>
            </div>
          </section>

          {/* 3. How We Use */}
          <section id="how-we-use" aria-labelledby="heading-how-we-use">
            <SectionHeading num="3" title="How We Use Your Data" id="heading-how-we-use" />
            <p className="mb-4">We use collected data <strong>only</strong> for the following purposes:</p>
            <ul className="list-disc list-inside space-y-2 text-[15px]">
              <li>Managing student attendance records</li>
              <li>Tracking academic performance</li>
              <li>Sending attendance notifications to parents</li>
              <li>Facilitating teacher–parent communication</li>
              <li>Managing homework assignments</li>
              <li>Administering tests and assessments</li>
              <li>School fee tracking</li>
              <li>Providing school management analytics to administrators</li>
            </ul>
            <div className="mt-6 bg-red-50 border border-red-100 rounded-xl px-5 py-4">
              <p className="text-sm font-semibold text-red-800 mb-2">We do NOT use data for:</p>
              <ul className="text-sm text-red-700 space-y-1 list-disc list-inside">
                <li>Targeted advertising</li>
                <li>Behavioural profiling</li>
                <li>Selling to third parties</li>
                <li>Marketing purposes</li>
                <li>Any purpose beyond school management</li>
              </ul>
            </div>
          </section>

          {/* 4. Legal Basis */}
          <section id="legal-basis" aria-labelledby="heading-legal-basis">
            <SectionHeading num="4" title="Legal Basis for Processing (DPDP Act Compliance)" id="heading-legal-basis" />
            <p className="mb-4">Under the DPDP Act 2023:</p>
            <ul className="list-disc list-inside space-y-3 text-[15px]">
              <li>
                We process student data <strong>on behalf of schools</strong> (who are the Data Fiduciaries under
                the Act). Eduvo acts as a Data Processor.
              </li>
              <li>
                Schools obtain consent from parents / guardians <strong>before onboarding students</strong> onto
                the platform.
              </li>
              <li>
                Parents are informed at the time of student registration about the purpose and scope of data
                processing.
              </li>
              <li>
                By using Eduvo, schools <strong>confirm they have obtained necessary parental consent</strong> as
                required under DPDP Act <strong>Section 9</strong>.
              </li>
              <li>
                For students under 18: <strong>verifiable parental consent is mandatory</strong> before any data
                processing begins.
              </li>
              <li>
                Schools are solely responsible for obtaining and maintaining consent records.
              </li>
            </ul>
          </section>

          {/* 5. Parental Consent */}
          <section id="parental-consent" aria-labelledby="heading-parental-consent">
            <SectionHeading num="5" title="Parental Consent & Children's Data" id="heading-parental-consent" />
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-5 py-4 mb-5">
              <p className="text-sm font-semibold text-blue-800 mb-1">Special Protections for Minors — DPDP Act 2023</p>
              <p className="text-sm text-blue-700">
                All students on Eduvo are treated as minors requiring parental consent, regardless of age,
                consistent with the intent of the DPDP Act.
              </p>
            </div>
            <ul className="list-disc list-inside space-y-3 text-[15px]">
              <li>Parent / guardian phone number is <strong>mandatory</strong> for all student accounts.</li>
              <li>Parents can access their child&rsquo;s data at any time via the Eduvo mobile app.</li>
              <li>
                <strong>No behavioural tracking</strong> or profiling of children is performed.
              </li>
              <li>
                <strong>No targeted advertising</strong> is directed at children.
              </li>
              <li>We do not track children&rsquo;s online behaviour outside the Eduvo platform.</li>
              <li>
                Schools must obtain <strong>written consent</strong> from parents before adding students to
                Eduvo.
              </li>
            </ul>
          </section>

          {/* 6. Data Sharing */}
          <section id="data-sharing" aria-labelledby="heading-data-sharing">
            <SectionHeading num="6" title="Data Sharing" id="heading-data-sharing" />
            <p className="mb-4">We share data <strong>only</strong> with the following:</p>

            <div className="space-y-3 mb-6">
              <SharedParty
                name="Your School / Institute"
                desc="Teachers and administrators of the school where the student is enrolled — no other school can access this data."
              />
              <SharedParty
                name="Firebase (Google)"
                desc="Used for push notifications only. Governed by Google's Privacy Policy."
                link="https://policies.google.com/privacy"
              />
              <SharedParty
                name="Supabase"
                desc="Secure database storage. Governed by Supabase's Privacy Policy."
                link="https://supabase.com/privacy"
              />
              <SharedParty
                name="MSG91"
                desc="SMS notification delivery. Governed by MSG91's Privacy Policy."
                link="https://msg91.com/privacy-policy"
              />
            </div>

            <div className="bg-red-50 border border-red-100 rounded-xl px-5 py-4">
              <p className="text-sm font-semibold text-red-800 mb-2">We do NOT share data with:</p>
              <ul className="text-sm text-red-700 space-y-1 list-disc list-inside">
                <li>Advertisers or ad networks</li>
                <li>Data brokers</li>
                <li>Any third party for commercial purposes</li>
                <li>Government bodies, except as required by Indian law</li>
              </ul>
            </div>
          </section>

          {/* 7. Storage & Security */}
          <section id="data-storage" aria-labelledby="heading-data-storage">
            <SectionHeading num="7" title="Data Storage & Security" id="heading-data-storage" />
            <ul className="list-disc list-inside space-y-3 text-[15px]">
              <li>All data stored on <strong>Supabase (PostgreSQL)</strong> servers.</li>
              <li>Data encrypted <strong>at rest and in transit</strong> (HTTPS / TLS).</li>
              <li>
                <strong>Row Level Security (RLS)</strong> ensures each school can only access its own data —
                no cross-school data leakage is possible.
              </li>
              <li>Passwords stored as <strong>bcrypt hashes</strong> — never stored in plain text.</li>
              <li>Access restricted to authorized school staff only.</li>
              <li>Regular security audits are performed.</li>
              <li>Data stored on <strong>Singapore region</strong> servers (Supabase).</li>
            </ul>
          </section>

          {/* 8. Data Retention */}
          <section id="data-retention" aria-labelledby="heading-data-retention">
            <SectionHeading num="8" title="Data Retention" id="heading-data-retention" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse mt-2">
                <thead>
                  <tr className="bg-blue-50 text-blue-900">
                    <th className="text-left px-4 py-3 rounded-tl-lg border border-blue-100 font-semibold">Data Type</th>
                    <th className="text-left px-4 py-3 rounded-tr-lg border border-blue-100 font-semibold">Retention Period</th>
                  </tr>
                </thead>
                <tbody className="text-gray-700">
                  <RetentionRow label="Active student / academic data" period="While school subscription is active" />
                  <RetentionRow label="After school cancels subscription" period="Retained for 90 days, then permanently deleted" />
                  <RetentionRow label="Attendance and marks records" period="Academic year + 1 year" />
                  <RetentionRow label="Audit logs" period="2 years (for security purposes)" />
                  <RetentionRow label="Parent deletion request" period="Processed within 7 working days" last />
                </tbody>
              </table>
            </div>
          </section>

          {/* 9. Your Rights */}
          <section id="your-rights" aria-labelledby="heading-your-rights">
            <SectionHeading num="9" title="Your Rights Under DPDP Act 2023" id="heading-your-rights" />
            <p className="mb-5 text-[15px]">
              As a parent or guardian, you have the following rights under the DPDP Act 2023:
            </p>
            <div className="space-y-4">
              <RightCard
                title="Right to Access"
                desc="Request a copy of your child's personal data we hold."
                action={<>Contact: <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline font-medium">privacy@eduvo.in</a></>}
              />
              <RightCard
                title="Right to Correction"
                desc="Request correction of inaccurate data. School admins can correct most data directly in the app."
                action={<>Contact your school admin or email <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline font-medium">privacy@eduvo.in</a></>}
              />
              <RightCard
                title="Right to Erasure (Right to be Forgotten)"
                desc="Request deletion of your child's personal data. We will process within 7 working days."
                action={<>Submit request at: <Link href="/delete-account" className="text-blue-600 hover:underline font-medium">eduvo.in/delete-account</Link></>}
              />
              <RightCard
                title="Right to Grievance Redressal"
                desc="Under DPDP Act Section 13, raise a grievance with our Grievance Officer. We respond within 48 hours and resolve within 30 days."
                action={<>Email: <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline font-medium">privacy@eduvo.in</a></>}
              />
              <RightCard
                title="Right to Nominate"
                desc="Nominate another person to exercise these rights on your behalf in case of incapacity."
                action={<>Contact: <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline font-medium">privacy@eduvo.in</a></>}
              />
            </div>
          </section>

          {/* 10. Data Deletion */}
          <section id="data-deletion" aria-labelledby="heading-data-deletion">
            <SectionHeading num="10" title="Data Deletion & Account Closure" id="heading-data-deletion" />
            <p className="mb-4 font-medium">To request data deletion:</p>
            <ol className="list-decimal list-inside space-y-2 text-[15px] mb-6">
              <li>Visit <Link href="/delete-account" className="text-blue-600 hover:underline font-medium">eduvo.in/delete-account</Link></li>
              <li>Submit your phone number and reason for deletion</li>
              <li>We process the request within <strong>7 working days</strong></li>
              <li>You receive a confirmation via SMS</li>
            </ol>
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-4 text-sm">
              <p className="font-semibold text-gray-800 mb-1">For complete school data deletion:</p>
              <p className="text-gray-600">
                School administrator contacts{' '}
                <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline">
                  privacy@eduvo.in
                </a>
                . All school data is permanently deleted within <strong>30 days</strong>.
              </p>
            </div>
          </section>

          {/* 11. Grievance Officer */}
          <section id="grievance-officer" aria-labelledby="heading-grievance-officer">
            <SectionHeading num="11" title="Grievance Officer" id="heading-grievance-officer" />
            <p className="mb-4 text-[15px]">
              As required by the IT Act 2000 and DPDP Act 2023, we have appointed a Grievance Officer:
            </p>
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-6 py-5 text-sm space-y-2">
              <InfoRow label="Grievance Officer" value="[Your Name]" />
              <InfoRow label="Company" value="Eduvo" />
              <InfoRow label="Address" value="Vadodara, Gujarat, India — 390001" />
              <InfoRow label="Email" value={<a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline">privacy@eduvo.in</a>} />
              <InfoRow label="Phone" value="[Your Phone Number]" />
              <InfoRow label="Available" value="Monday to Friday, 10 AM – 6 PM IST" />
              <InfoRow label="Response time" value="Within 48 hours" />
              <InfoRow label="Resolution time" value="Within 30 days of receipt" />
            </div>
          </section>

          {/* 12. Data Breach */}
          <section id="data-breach" aria-labelledby="heading-data-breach">
            <SectionHeading num="12" title="Data Breach Notification" id="heading-data-breach" />
            <p className="mb-4 text-[15px]">In the event of a personal data breach:</p>
            <ul className="list-disc list-inside space-y-3 text-[15px]">
              <li>
                Affected schools will be notified <strong>within 72 hours</strong> of discovery.
              </li>
              <li>Schools will notify affected parents as required under the DPDP Act.</li>
              <li>
                We will report to the <strong>Data Protection Board of India</strong> as required under the DPDP
                Act and DPDP Rules 2025.
              </li>
              <li>We maintain documented incident response procedures to minimise impact.</li>
            </ul>
            <p className="mt-4 text-sm text-gray-600">
              For urgent data breach reports, email:{' '}
              <a href="mailto:security@eduvo.in" className="text-blue-600 hover:underline font-medium">
                security@eduvo.in
              </a>
            </p>
          </section>

          {/* 13. Cookies */}
          <section id="cookies" aria-labelledby="heading-cookies">
            <SectionHeading num="13" title="Cookies & Tracking" id="heading-cookies" />

            <p className="mb-3 font-medium text-gray-900">Web Dashboard (eduvo.in):</p>
            <ul className="list-disc list-inside space-y-2 text-[15px] mb-5">
              <li>We use <strong>only essential cookies</strong> for login sessions.</li>
              <li>No advertising cookies.</li>
              <li>No third-party tracking cookies.</li>
              <li>No Google Analytics or similar tracking tools.</li>
            </ul>

            <p className="mb-3 font-medium text-gray-900">Mobile App:</p>
            <ul className="list-disc list-inside space-y-2 text-[15px]">
              <li>No tracking SDKs.</li>
              <li>Firebase used for push notifications only.</li>
              <li>No advertising SDKs.</li>
            </ul>
          </section>

          {/* 14. Third Party Links */}
          <section id="third-party-links" aria-labelledby="heading-third-party-links">
            <SectionHeading num="14" title="Third Party Links" id="heading-third-party-links" />
            <p className="text-[15px]">
              Our platform may contain links to third-party websites or services. Eduvo is not responsible for
              the privacy practices of those sites. We encourage you to read their privacy policies before
              providing any personal information.
            </p>
          </section>

          {/* 15. Changes */}
          <section id="changes" aria-labelledby="heading-changes">
            <SectionHeading num="15" title="Changes to This Policy" id="heading-changes" />
            <ul className="list-disc list-inside space-y-2 text-[15px]">
              <li>
                We may update this policy periodically. Changes will be posted at{' '}
                <strong>eduvo.in/privacy-policy</strong> with an updated &ldquo;Last Updated&rdquo; date.
              </li>
              <li>
                Schools and users will be notified of significant changes via email or in-app notification.
              </li>
              <li>
                Continued use of Eduvo after changes are posted constitutes acceptance of the updated policy.
              </li>
            </ul>
          </section>

          {/* 16. Contact */}
          <section id="contact" aria-labelledby="heading-contact">
            <SectionHeading num="16" title="Contact Us" id="heading-contact" />
            <p className="mb-4 text-[15px]">For any privacy-related queries:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-6 py-5 text-sm space-y-2 mb-4">
              <InfoRow label="Email" value={<a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline">privacy@eduvo.in</a>} />
              <InfoRow label="Address" value="Vadodara, Gujarat, India" />
              <InfoRow label="Response time" value="48 hours on working days" />
            </div>
            <p className="text-sm text-gray-600">
              For urgent data breach reports:{' '}
              <a href="mailto:security@eduvo.in" className="text-blue-600 hover:underline font-medium">
                security@eduvo.in
              </a>
            </p>
          </section>

        </div>{/* end sections */}

        {/* ── Footer ── */}
        <footer className="mt-16 pt-8 border-t border-gray-200">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500 print:hidden">
            <Link href="/" className="hover:text-gray-900 transition-colors">Home</Link>
            <Link href="/terms-of-service" className="hover:text-gray-900 transition-colors">Terms of Service</Link>
            <Link href="/delete-account" className="hover:text-gray-900 transition-colors">Delete Account</Link>
            <a href="mailto:privacy@eduvo.in" className="hover:text-gray-900 transition-colors">Contact</a>
          </div>
          <p className="mt-4 text-xs text-gray-400">
            © {new Date().getFullYear()} Eduvo. All rights reserved. Vadodara, Gujarat, India.
          </p>
        </footer>
      </main>

      {/* ── Back to Top ── */}
      {showBackToTop && (
        <button
          onClick={scrollToTop}
          aria-label="Back to top"
          className="fixed bottom-6 right-6 z-50 bg-blue-600 hover:bg-blue-700 text-white rounded-full w-11 h-11 flex items-center justify-center shadow-lg transition-colors print:hidden"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {/* ── Print styles ── */}
      <style>{`
        @media print {
          body { font-size: 12pt; color: #000; }
          a { color: #000 !important; text-decoration: underline; }
          section { break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

/* ── Helper components ── */

function SectionHeading({ num, title, id }: { num: string; title: string; id: string }) {
  return (
    <h2
      id={id}
      className="text-xl font-bold text-blue-600 mb-4 flex items-baseline gap-2 scroll-mt-24"
    >
      <span className="text-blue-400 font-normal text-base">{num}.</span>
      {title}
    </h2>
  );
}

function DataGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <p className="font-semibold text-gray-800 mb-2 text-[15px]">{title}</p>
      <ul className="list-disc list-inside space-y-1 text-[15px] text-gray-700 pl-2">{children}</ul>
    </div>
  );
}

function SharedParty({ name, desc, link }: { name: string; desc: string; link?: string }) {
  return (
    <div className="flex gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
      <div className="mt-0.5">
        <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5" />
      </div>
      <div className="text-sm">
        <span className="font-semibold text-gray-800">{name}</span>
        {' — '}
        <span className="text-gray-600">{desc}</span>
        {link && (
          <>
            {' '}
            <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">
              View policy ↗
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function RetentionRow({ label, period, last }: { label: string; period: string; last?: boolean }) {
  return (
    <tr className={last ? '' : 'border-b border-gray-100'}>
      <td className="px-4 py-3 border border-gray-100 text-gray-700">{label}</td>
      <td className="px-4 py-3 border border-gray-100 text-gray-600">{period}</td>
    </tr>
  );
}

function RightCard({ title, desc, action }: { title: string; desc: string; action: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-xl px-5 py-4">
      <p className="font-semibold text-gray-900 mb-1">{title}</p>
      <p className="text-[15px] text-gray-600 mb-2">{desc}</p>
      <p className="text-sm text-gray-500">{action}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-gray-500 min-w-[130px] shrink-0">{label}:</span>
      <span className="text-gray-800 font-medium">{value}</span>
    </div>
  );
}
