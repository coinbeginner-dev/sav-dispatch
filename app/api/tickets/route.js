import { NextResponse } from 'next/server';
import { hasDb, getDay, saveUpload, assignTickets, setStatut, getAvancement } from '../../../lib/db';

export const dynamic = 'force-dynamic';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Tickets du jour (rechargement de page / autre appareil)
export async function GET(req) {
  if (!hasDb()) return NextResponse.json({ db: false });
  try {
    const day = new URL(req.url).searchParams.get('day') || today();
    return NextResponse.json({ db: true, ...(await getDay(day)) });
  } catch (e) {
    return NextResponse.json({ db: false, error: String(e.message || e) }, { status: 500 });
  }
}

// Dépôt du fichier du matin (tickets déjà parsés côté client)
export async function POST(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const { day, tickets } = await req.json();
    if (!Array.isArray(tickets)) {
      return NextResponse.json({ error: 'tickets manquants' }, { status: 400 });
    }
    return NextResponse.json({ db: true, ...(await saveUpload(day || today(), tickets)) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}

// Réaffectation manuelle (tech) ou statut terrain (statut)
export async function PATCH(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const body = await req.json();
    const day = body.day || today();
    if ('statut' in body) {
      const r = await setStatut(body.refs, body.statut, {
        day, motif: body.motif || null, source: body.source || 'chef',
      });
      return NextResponse.json({ ...r, avancement: await getAvancement(day) });
    }
    return NextResponse.json(await assignTickets(body.refs, body.tech, day));
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
