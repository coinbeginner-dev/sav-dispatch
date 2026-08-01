import { NextResponse } from 'next/server';
import {
  hasDb, getDay, saveUpload, assignTickets, setStatut, getAvancement, arbitrer,
  getDernierJourAvecTickets, marquerEnvoye, rechercheGlobale, rouvrirTicket, updateContact,
} from '../../../lib/db';

export const dynamic = 'force-dynamic';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Tickets du jour (rechargement de page / autre appareil). Si le jour demandé
// n'a encore aucun ticket (aucun fichier chargé aujourd'hui), on retombe sur
// le dernier jour connu plutôt que de renvoyer un écran vide : l'orienteur
// voit ce qui restait en cours, avec les affectations déjà faites, et peut
// commencer à travailler dessus avant même que le fichier du matin arrive.
export async function GET(req) {
  if (!hasDb()) return NextResponse.json({ db: false });
  try {
    const url = new URL(req.url);
    const terme = url.searchParams.get('recherche');
    if (terme) {
      return NextResponse.json({ db: true, resultats: await rechercheGlobale(terme) });
    }
    const demande = url.searchParams.get('day') || today();
    let jour = demande;
    let resultat = await getDay(jour);
    let reporte = false;
    if (resultat.tickets.length === 0) {
      const dernier = await getDernierJourAvecTickets();
      if (dernier && dernier !== jour) {
        jour = dernier;
        resultat = await getDay(jour);
        reporte = true;
      }
    }
    return NextResponse.json({ db: true, ...resultat, jourDemande: demande, jourAffiche: jour, reporte });
  } catch (e) {
    return NextResponse.json({ db: false, error: String(e.message || e) }, { status: 500 });
  }
}

// Dépôt du fichier du matin (tickets déjà parsés côté client)
export async function POST(req) {
  if (!hasDb()) return NextResponse.json({ db: false }, { status: 503 });
  try {
    const { day, tickets, clore } = await req.json();
    if (!Array.isArray(tickets)) {
      return NextResponse.json({ error: 'tickets manquants' }, { status: 400 });
    }
    return NextResponse.json({ db: true, ...(await saveUpload(day || today(), tickets, { clore: Boolean(clore) })) });
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
    if ('arbitrage' in body) {
      return NextResponse.json(await arbitrer(body.refs, day, body.arbitrage, body.motif || null));
    }
    if ('envoye' in body) {
      return NextResponse.json(await marquerEnvoye(body.refs));
    }
    if ('reouvrir' in body) {
      return NextResponse.json(await rouvrirTicket(body.refs, day));
    }
    if ('contact' in body) {
      return NextResponse.json(await updateContact(body.refs, body.contact));
    }
    if ('statut' in body) {
      const r = await setStatut(body.refs, body.statut, {
        day, motif: body.motif || null, texte: body.texte || null,
        source: body.source || 'chef',
      });
      return NextResponse.json({ ...r, avancement: await getAvancement(day) });
    }
    return NextResponse.json(await assignTickets(body.refs, body.tech, day));
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}
