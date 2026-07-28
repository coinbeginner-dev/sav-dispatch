import { NextResponse } from 'next/server';

export async function GET(req) {
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  const res = NextResponse.redirect(url);
  res.cookies.set('session', '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
