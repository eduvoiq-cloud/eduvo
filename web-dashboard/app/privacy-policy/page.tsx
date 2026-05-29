import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy — Eduvo',
  description: 'How Eduvo collects, uses, and protects your data.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">E</span>
          </div>
          <span className="text-gray-900 font-semibold text-lg tracking-tight">eduvo</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: May 2026</p>

        <div className="space-y-10 text-gray-700 leading-relaxed">

          {/* Section 1 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. What Data We Collect</h2>
            <p className="mb-3">
              Eduvo collects only the data necessary to provide school management services. This includes:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li><strong>Student information:</strong> Full name, class/grade, roll number, date of birth, and photo (if uploaded by the school).</li>
              <li><strong>Attendance records:</strong> Daily attendance status (present, absent, late) per student.</li>
              <li><strong>Academic records:</strong> Marks, test scores, assignments, and performance data entered by teachers.</li>
              <li><strong>Parent/guardian contact:</strong> Name, email address, and phone number for communication and notifications.</li>
              <li><strong>Account credentials:</strong> Email address and hashed password for login. Passwords are never stored in plain text.</li>
              <li><strong>Usage data:</strong> Basic logs of actions performed within the platform for security and audit purposes.</li>
            </ul>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. How We Use Your Data</h2>
            <p className="mb-3">
              All data collected is used exclusively for school management purposes. Specifically:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li>To provide attendance tracking, marks management, and academic reporting features.</li>
              <li>To send notifications to parents and students about attendance, marks, and school announcements.</li>
              <li>To allow teachers and administrators to manage student records.</li>
              <li>To maintain audit logs for security and accountability.</li>
            </ul>
            <p className="mt-4 text-sm font-medium text-gray-900 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3">
              We do not sell, rent, or share your personal data with any third parties for marketing or commercial purposes.
            </p>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Data Storage</h2>
            <p className="text-sm">
              All data is stored securely on <strong>Supabase</strong> infrastructure, which uses industry-standard
              encryption at rest and in transit (TLS/SSL). Supabase is hosted on AWS and complies with SOC 2 Type II
              standards. Data is stored in the region selected during school onboarding. We do not store data on
              local servers or unencrypted media.
            </p>
          </section>

          {/* Section 4 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Parent &amp; Guardian Rights</h2>
            <p className="mb-3 text-sm">
              Parents and guardians have the following rights regarding their child&apos;s data:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li><strong>Access:</strong> You may request a copy of all data held about your child at any time.</li>
              <li><strong>Correction:</strong> You may request corrections to inaccurate data by contacting your school administrator.</li>
              <li><strong>Deletion:</strong> You may request deletion of your account and associated data. Requests are processed within 7 business days.</li>
              <li><strong>Portability:</strong> School administrators can export all school data in a structured format.</li>
            </ul>
            <p className="mt-4 text-sm">
              To exercise any of these rights, please use our{' '}
              <Link href="/delete-account" className="text-blue-600 hover:underline font-medium">
                account deletion request form
              </Link>{' '}
              or contact us directly.
            </p>
          </section>

          {/* Section 5 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Data Retention</h2>
            <p className="text-sm">
              Student and academic records are retained for the duration of the school&apos;s active subscription.
              Upon account termination or deletion request, all personal data is permanently deleted within 30 days,
              except where retention is required by applicable law.
            </p>
          </section>

          {/* Section 6 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Cookies &amp; Tracking</h2>
            <p className="text-sm">
              The Eduvo web dashboard uses session cookies solely for authentication purposes. We do not use
              third-party tracking cookies, advertising pixels, or analytics services that share data with
              external parties.
            </p>
          </section>

          {/* Section 7 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Children&apos;s Privacy</h2>
            <p className="text-sm">
              Eduvo is a school management platform. Student data is provided and managed by the school
              (the data controller). Schools are responsible for obtaining appropriate consent from parents
              or guardians before entering student data into the platform, in accordance with applicable
              local laws and regulations.
            </p>
          </section>

          {/* Section 8 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Contact Us</h2>
            <p className="text-sm">
              For any privacy-related questions, data requests, or concerns, please contact our privacy team:
            </p>
            <div className="mt-3 bg-gray-100 rounded-lg px-4 py-3 text-sm">
              <p className="font-medium text-gray-900">Eduvo Privacy Team</p>
              <p className="text-gray-600">
                Email:{' '}
                <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline">
                  privacy@eduvo.in
                </a>
              </p>
            </div>
          </section>

        </div>

        {/* Footer links */}
        <div className="mt-12 pt-8 border-t border-gray-200 flex flex-wrap gap-4 text-sm text-gray-500">
          <Link href="/" className="hover:text-gray-900 transition-colors">Home</Link>
          <Link href="/terms-of-service" className="hover:text-gray-900 transition-colors">Terms of Service</Link>
          <Link href="/delete-account" className="hover:text-gray-900 transition-colors">Delete Account</Link>
          <Link href="/login" className="hover:text-gray-900 transition-colors">Sign In</Link>
        </div>
      </main>
    </div>
  );
}
