import { redirect } from 'next/navigation';

/**
 * Root route — middleware handles auth redirects,
 * but as a fallback just send to login.
 */
export default function RootPage() {
  redirect('/login');
}
