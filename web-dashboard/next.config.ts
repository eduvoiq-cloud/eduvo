import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// RAILWAY_API_URL must be set in Vercel environment variables.
// It should be the full Railway backend URL, e.g. https://eduvo-api.up.railway.app
// It is intentionally NOT prefixed with NEXT_PUBLIC_ so it stays server-side only.
const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

// ── Security headers ──────────────────────────────────────────────────────────
// Applied to every response from Next.js.
const securityHeaders = [
  // Prevent the page from being embedded in an iframe (clickjacking protection)
  { key: 'X-Frame-Options', value: 'DENY' },
  // Prevent MIME type sniffing
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Force HTTPS for 1 year, include subdomains
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  // Control referrer information sent with requests
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Restrict browser features
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Basic Content Security Policy — tightened for production
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js requires 'unsafe-inline' for its inline styles/scripts in dev;
      // in production these are hashed but we use 'unsafe-inline' as a safe baseline.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      // Allow API calls to our own origin and the Railway backend
      `connect-src 'self' ${process.env.RAILWAY_API_URL ?? ''} https://*.supabase.co wss://*.supabase.co https://*.ingest.us.sentry.io https://*.sentry.io`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },

  async rewrites() {
    // In production (Vercel), proxy all /api/* requests to Railway.
    // In local dev, RAILWAY_API_URL is not set so rewrites are empty —
    // the dev server hits localhost:3001 directly via NEXT_PUBLIC_API_URL.
    if (!RAILWAY_API_URL) {
      return [];
    }

    return [
      {
        source: "/api/:path*",
        destination: `${RAILWAY_API_URL}/api/:path*`,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: "eduvo",
  project: "eduvo-web",

  // Source map upload auth token — set SENTRY_AUTH_TOKEN in your environment.
  // Generate one at: https://sentry.io/settings/auth-tokens/
  // Add it to Vercel env vars and your local .env.sentry-build-plugin (gitignored).
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload a broader set of client files for better stack trace resolution
  widenClientFileUpload: true,

  // Proxy Sentry event requests through /monitoring to bypass ad-blockers
  tunnelRoute: "/monitoring",

  // Suppress non-CI build output
  silent: !process.env.CI,
});
