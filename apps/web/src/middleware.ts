// Signed-out visitors of a console page go to /login (Auth.js `authorized` callback in lib/auth.ts). The sign-in
// page, the Auth.js routes, the API routes (they answer 401 themselves) and static files are not matched.
export { auth as middleware } from './lib/auth';

export const config = {
  // Node runtime: Auth.js decrypts the session cookie with APIs the Edge runtime lacks.
  runtime: 'nodejs',
  matcher: ['/((?!login|api/|_next/|brand/|fonts/|favicon\\.ico).*)'],
};
