import { NextResponse } from 'next/server';
import { verifySession } from './lib/auth';

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Chemins publics (pas d'auth requise).
  // /api/whatsapp est appelé par Meta : pas de session possible, il s'authentifie
  // par le verify_token (validation) puis par la signature HMAC (messages entrants).
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/login') ||
    pathname.startsWith('/api/whatsapp') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get('session')?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
