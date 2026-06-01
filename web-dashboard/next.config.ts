import type { NextConfig } from "next";

// RAILWAY_API_URL must be set in Vercel environment variables.
// It should be the full Railway backend URL, e.g. https://eduvo-api.up.railway.app
// It is intentionally NOT prefixed with NEXT_PUBLIC_ so it stays server-side only.
const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

const nextConfig: NextConfig = {
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

export default nextConfig;
