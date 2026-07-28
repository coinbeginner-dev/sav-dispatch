import { NextResponse } from 'next/server';
import { hasDb, getSettings, saveSettings } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!hasDb()) return NextResponse.json({ db: false });
  try {
    return NextResponse.json({ db: true, ...(await getSettings()) });
  } catch (e) {
    return NextResponse.json({ db: false, error: String(e.message || e) }, { status: 500 });
  }
}

export async function PUT(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const body = await req.json();
    return NextResponse.json({ db: true, ...(await saveSettings(body)) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
