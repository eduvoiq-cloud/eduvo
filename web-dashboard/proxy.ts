/**
 * DEPRECATED — this file is no longer the active middleware.
 *
 * Next.js only picks up middleware from a file named `middleware.ts` at the
 * project root. This file was never loaded by Next.js and has been superseded
 * by `middleware.ts` which was created to fix the broken route protection.
 *
 * This file is kept only to avoid breaking any tooling that may import it.
 * Do not add logic here — edit `middleware.ts` instead.
 */
import { NextRequest, NextResponse } from 'next/server';

export function proxy(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
