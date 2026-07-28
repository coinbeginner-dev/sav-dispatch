// Webhook WhatsApp Business Cloud API.
// GET  : validation de l'abonnement par Meta (hub.verify_token)
// POST : réception des messages (texte, vocal, photo) envoyés par les chefs d'équipe
//
// Route publique (exclue du middleware d'auth) : Meta n'a pas de session.
// Elle s'authentifie par le verify_token à l'abonnement, puis par la signature
// HMAC-SHA256 de Meta sur chaque message entrant.
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import {
  hasDb, saveInbound, saveStatus, saveHit,
  chefParTelephone, ticketsDuJourPourChef, setStatut, getDay,
} from '../../../lib/db';
import { analyser, messageConfirmation, refsCitees } from '../../../lib/extraction';
import { envoyerTexte } from '../../../lib/whatsapp';

export const dynamic = 'force-dynamic';

// Validation de l'abonnement (Meta appelle une fois, à la configuration)
export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const attendu = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!attendu) {
    return new NextResponse('WHATSAPP_VERIFY_TOKEN non configuré', { status: 500 });
  }
  if (p.get('hub.mode') === 'subscribe' && p.get('hub.verify_token') === attendu) {
    return new NextResponse(p.get('hub.challenge') || '', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  }
  return new NextResponse('verify_token invalide', { status: 403 });
}

// Meta signe chaque requête avec le secret de l'app qui reçoit. On accepte
// plusieurs secrets (séparés par des virgules) afin de pouvoir changer de
// numéro ou d'app sans coupure de réception.
// Sans secret configuré on refuse en bloc — cet endpoint est public et écrit en
// base, il ne doit jamais s'ouvrir par défaut de configuration.
function signatureValide(brut, entete) {
  const secrets = (process.env.WHATSAPP_APP_SECRET || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!secrets.length) return null;
  if (!entete?.startsWith('sha256=')) return false;

  const recu = Buffer.from(entete);
  for (const secret of secrets) {
    const attendu = Buffer.from(
      'sha256=' + crypto.createHmac('sha256', secret).update(brut, 'utf8').digest('hex')
    );
    if (attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu)) return true;
  }
  return false;
}

// Aplatit la charge utile Meta : messages reçus d'un côté, accusés de statut de l'autre.
// Meta envoie les deux sur le même champ `messages`.
function extraire(payload) {
  const out = [];
  const statuts = [];
  for (const entry of payload?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const contacts = {};
      for (const c of v.contacts || []) contacts[c.wa_id] = c.profile?.name || '';
      for (const s of v.statuses || []) {
        const err = (s.errors || [])[0] || {};
        statuts.push({
          id: s.id,
          recipient: s.recipient_id || '',
          status: s.status || '',
          errorCode: err.code != null ? String(err.code) : null,
          errorTitle: err.title || err.message || null,
        });
      }
      for (const m of v.messages || []) {
        out.push({
          id: m.id,
          from: m.from || '',
          name: contacts[m.from] || '',
          type: m.type || '',
          text: m.text?.body || m.button?.text || m.interactive?.list_reply?.title || null,
          mediaId: m.audio?.id || m.image?.id || m.video?.id || m.document?.id || null,
          raw: m,
        });
      }
    }
  }
  return { messages: out, statuts };
}

function aujourdhui() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Traite un message d'un chef d'équipe : identification, lecture, écriture,
// puis accusé de réception. L'accusé rappelle le nom du client, ce qui permet
// au chef de repérer immédiatement une erreur de numéro et de la corriger.
async function traiterMessage(m) {
  const chef = await chefParTelephone(m.from);
  if (!chef) {
    return envoyerTexte(m.from,
      "Ce numéro n'est pas reconnu comme chef d'équipe. "
      + "Demande à l'orienteur de l'ajouter dans les réglages de SAV Dispatch.");
  }

  if (m.type !== 'text' || !m.text) {
    return envoyerTexte(m.from, messageConfirmation({ instructions: [], ignorees: [] }, m.type));
  }

  const jour = aujourdhui();
  const tickets = await ticketsDuJourPourChef(jour, chef.name);
  if (!tickets.length) {
    return envoyerTexte(m.from, `Aucune intervention enregistrée aujourd'hui pour tes équipes.`);
  }

  const res = analyser(m.text, tickets);

  // Un numéro valide mais confié à une autre équipe doit être signalé comme tel :
  // dire « numéro manquant » enverrait le chef chercher une faute inexistante.
  const tousDuJour = (await getDay(jour)).tickets;
  res.horsPerimetre = refsCitees(m.text, tousDuJour)
    .filter((ref) => !tickets.some((t) => t.ref === ref));

  for (const i of res.instructions) {
    if (i.annulation) {
      await setStatut([i.ref], null, { day: jour });
    } else if (i.statut) {
      await setStatut([i.ref], i.statut, { day: jour, motif: i.note, source: 'whatsapp' });
    }
  }
  return envoyerTexte(m.from, messageConfirmation(res, 'text'));
}

export async function POST(req) {
  const brut = await req.text();
  const entete = req.headers.get('x-hub-signature-256');
  const ok = signatureValide(brut, entete);

  // Diagnostic : on trace l'appel avant tout rejet, sans stocker de contenu.
  const resultat = ok === true ? 'accepte' : ok === false ? 'signature refusee' : 'secret absent';
  console.log(`webhook whatsapp : ${resultat}, ${brut.length} octets, signature ${entete ? 'presente' : 'absente'}`);
  if (hasDb()) await saveHit({ signature: entete ? 'presente' : 'absente', taille: brut.length, resultat });

  if (ok === null) return new NextResponse('WHATSAPP_APP_SECRET non configuré', { status: 503 });
  if (ok === false) return new NextResponse('signature invalide', { status: 401 });

  // On acquitte toujours en 200 : sinon Meta rejoue le message en boucle.
  try {
    const { messages, statuts } = extraire(JSON.parse(brut));
    if (hasDb()) {
      for (const s of statuts) await saveStatus(s);
      for (const m of messages) {
        // Meta rejoue les webhooks non acquittés : on ne traite qu'une fois.
        const { nouveau } = await saveInbound(m);
        if (nouveau) await traiterMessage(m);
      }
    }
  } catch (e) {
    console.error('webhook whatsapp :', e.message);
  }
  return NextResponse.json({ received: true });
}
