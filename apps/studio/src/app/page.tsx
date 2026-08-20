import { redirect } from 'next/navigation';

/**
 * The bare root resolves to the org switcher rather than guessing an org. Middleware has
 * already established that there is a session by the time this renders.
 */
export default function RootPage(): never {
  redirect('/orgs');
}
