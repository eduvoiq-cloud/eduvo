'use client';
// global-error.tsx
// Catches errors that bubble up to the root layout (React render errors, etc.)
// and reports them to Sentry before showing a fallback UI.
import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        {/* Render Next.js default error page as the fallback UI */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
