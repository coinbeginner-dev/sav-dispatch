import { NextResponse } from 'next/server';
import { getUsers, createSession } from '../../../lib/auth';

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Requête invalide' }, { status: 400 });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const users = getUsers();
  const user = users.find(
    (u) => String(u.email).toLowerCase() === email && u.pass === password
  );

  if (!user) {
    return NextResponse.json(
      { ok: false, error: 'Email ou mot de passe incorrect.' },
      { status: 401 }
    );
  }

  const token = await createSession(user.email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
