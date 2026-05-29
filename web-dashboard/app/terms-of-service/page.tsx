import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service — Eduvo',
  description: 'Terms and conditions for using the Eduvo school management platform.',
};

export default function TermsOfServicePage() {
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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: May 2026</p>

        <div className="space-y-10 text-gray-700 leading-relaxed">

          {/* Section 1 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Service Description</h2>
            <p className="text-sm">
              Eduvo is a cloud-based school management platform that provides tools for attendance tracking,
              marks management, parent communication, fee management, and academic reporting. The platform
              is accessible via a web dashboard and a mobile application for parents and students.
            </p>
            <p className="mt-3 text-sm">
              By accessing or using Eduvo, you agree to be bound by these Terms of Service. If you do not
              agree to these terms, you may not use the platform.
            </p>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. School Responsibilities</h2>
            <p className="mb-3 text-sm">
              Schools subscribing to Eduvo (&quot;School Administrators&quot;) are responsible for:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li>Ensuring all data entered into the platform is accurate and up to date.</li>
              <li>Obtaining appropriate consent from parents and guardians before entering student data.</li>
              <li>Managing user accounts and access permissions for teachers, parents, and students.</li>
              <li>Complying with applicable local data protection and privacy laws.</li>
              <li>Keeping login credentials confidential and reporting any unauthorized access immediately.</li>
              <li>Ensuring that the platform is used only for lawful school management purposes.</li>
            </ul>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Acceptable Use</h2>
            <p className="mb-3 text-sm">You agree not to use Eduvo to:</p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li>Upload or transmit any unlawful, harmful, or offensive content.</li>
              <li>Attempt to gain unauthorized access to any part of the platform or other users&apos; accounts.</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the platform.</li>
              <li>Use the platform to send unsolicited communications (spam).</li>
              <li>Interfere with or disrupt the integrity or performance of the platform.</li>
              <li>Use automated scripts or bots to access the platform without prior written consent.</li>
            </ul>
            <p className="mt-3 text-sm">
              Violation of acceptable use policies may result in immediate suspension or termination of access.
            </p>
          </section>

          {/* Section 4 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Subscription Terms</h2>
            <p className="mb-3 text-sm">
              Access to Eduvo is provided on a subscription basis. The following terms apply:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li><strong>Billing:</strong> Subscriptions are billed on a monthly or annual basis as agreed at the time of onboarding.</li>
              <li><strong>Renewal:</strong> Subscriptions renew automatically unless cancelled at least 7 days before the renewal date.</li>
              <li><strong>Upgrades/Downgrades:</strong> Plan changes take effect at the start of the next billing cycle.</li>
              <li><strong>Refunds:</strong> Refunds are not provided for partial months. Annual subscriptions may be eligible for a pro-rated refund within 30 days of purchase.</li>
              <li><strong>Free trial:</strong> Where a free trial is offered, no payment is required during the trial period. Trials convert to paid subscriptions unless cancelled before the trial ends.</li>
            </ul>
          </section>

          {/* Section 5 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Termination Policy</h2>
            <p className="mb-3 text-sm">
              Either party may terminate the subscription at any time:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li><strong>By the school:</strong> Schools may cancel their subscription at any time through the settings page or by contacting support. Access continues until the end of the current billing period.</li>
              <li><strong>By Eduvo:</strong> We reserve the right to suspend or terminate access immediately if a school violates these Terms of Service, engages in fraudulent activity, or fails to pay subscription fees.</li>
              <li><strong>Data upon termination:</strong> Following termination, school data is retained for 30 days to allow for export, after which it is permanently deleted.</li>
            </ul>
          </section>

          {/* Section 6 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Intellectual Property</h2>
            <p className="text-sm">
              All software, design, trademarks, and content comprising the Eduvo platform are the exclusive
              property of Eduvo and its licensors. Schools retain ownership of all data they enter into the
              platform. By using the platform, schools grant Eduvo a limited license to process their data
              solely for the purpose of providing the service.
            </p>
          </section>

          {/* Section 7 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Limitation of Liability</h2>
            <p className="mb-3 text-sm">
              To the maximum extent permitted by applicable law:
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm">
              <li>Eduvo is provided &quot;as is&quot; without warranties of any kind, express or implied.</li>
              <li>Eduvo shall not be liable for any indirect, incidental, special, or consequential damages arising from the use or inability to use the platform.</li>
              <li>Our total liability to any school shall not exceed the amount paid by that school in the 3 months preceding the claim.</li>
              <li>We do not guarantee uninterrupted or error-free service, though we strive for high availability.</li>
            </ul>
          </section>

          {/* Section 8 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Changes to Terms</h2>
            <p className="text-sm">
              We may update these Terms of Service from time to time. Schools will be notified of material
              changes via email at least 14 days before they take effect. Continued use of the platform
              after the effective date constitutes acceptance of the updated terms.
            </p>
          </section>

          {/* Section 9 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Custom Terms</h2>
            <p className="text-sm">
              Schools with specific legal or compliance requirements may request custom terms. Please contact
              us at{' '}
              <a href="mailto:privacy@eduvo.in" className="text-blue-600 hover:underline">
                privacy@eduvo.in
              </a>{' '}
              to discuss custom agreements.
            </p>
          </section>

          {/* Section 10 */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Governing Law</h2>
            <p className="text-sm">
              These Terms of Service are governed by and construed in accordance with applicable law.
              Any disputes arising from these terms shall be resolved through good-faith negotiation,
              and if unresolved, through binding arbitration.
            </p>
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">Contact</h2>
            <div className="bg-gray-100 rounded-lg px-4 py-3 text-sm">
              <p className="font-medium text-gray-900">Eduvo Support</p>
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
          <Link href="/privacy-policy" className="hover:text-gray-900 transition-colors">Privacy Policy</Link>
          <Link href="/delete-account" className="hover:text-gray-900 transition-colors">Delete Account</Link>
          <Link href="/login" className="hover:text-gray-900 transition-colors">Sign In</Link>
        </div>
      </main>
    </div>
  );
}
