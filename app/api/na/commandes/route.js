import { NextResponse } from 'next/server';
import { hasDb, getVue, importCommandes, setStatut, assignTeam } from '../../../../lib/na-db';

export const dynamic = 'force-dynamic';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET() {
  if (!hasDb()) return NextResponse.json({ db: false });
  try {
    return NextResponse.json({ db: true, ...(await getVue()) });
  } catch (e) {
    return NextResponse.json({ db: false, error: String(e.message || e) }, { status: 500 });
  }
}

// Import du fichier "Commandes" (démarrage avec colonnes Statut Connect /
// Status Rafik, ou imports suivants sans ces colonnes — géré côté parseur).
export async function POST(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const { commandes, avecStatutDepart } = await req.json();
    if (!Array.isArray(commandes)) {
      return NextResponse.json({ error: 'commandes manquantes' }, { status: 400 });
    }
    const res = await importCommandes(commandes, { day: today(), avecStatutDepart: Boolean(avecStatutDepart) });
    return NextResponse.json({ db: true, ...res, ...(await getVue()) });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}

// Statut (fait/blocage/annulé) ou réaffectation d'équipe.
export async function PATCH(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const body = await req.json();
    if ('statut' in body) {
      const r = await setStatut(body.refs, body.statut, {
        motif: body.motif || null, texte: body.texte || null, po: body.po || null,
        source: body.source || 'chef',
      });
      return NextResponse.json(r);
    }
    return NextResponse.json(await assignTeam(body.refs, body.team));
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
