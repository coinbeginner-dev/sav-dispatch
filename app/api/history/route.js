import { NextResponse } from 'next/server';
import { hasDb, getHistory } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!hasDb()) return NextResponse.json({ db: false });
  try {
    return NextResponse.json({ db: true, ...(await getHistory()) });
  } catch (e) {
    return NextResponse.json({ db: false, error: String(e.message || e) }, { status: 500 });
  }
}
