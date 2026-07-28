// Webhook WhatsApp Business Cloud API.
// GET  : validation de l'abonnement par Meta (hub.verify_token)
// POST : réception des messages (texte, vocal, photo) envoyés par les chefs d'équipe
//
// Route publique (exclue du middleware d'auth) : Meta n'a pas de session.
// Elle s'authentifie par le verify_token à l'abonnement, puis par la signature
// HMAC-SHA256 de Meta sur chaque message entrant.
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { hasDb, saveInbound, saveStatus, saveHit } from '../../../lib/db';

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

// Meta signe chaque requête avec l'app secret : on rejette tout ce qui ne colle pas.
// Sans secret configuré on refuse en bloc — cet endpoint est public et écrit en base,
// il ne doit jamais s'ouvrir par défaut de configuration.
function signatureValide(brut, entete) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return null;
  if (!entete?.startsWith('sha256=')) return false;
  const attendu = 'sha256=' + crypto.createHmac('sha256', secret).update(brut, 'utf8').digest('hex');
  const a = Buffer.from(attendu);
  const b = Buffer.from(entete);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      for (const m of messages) await saveInbound(m);
      for (const s of statuts) await saveStatus(s);
    }
  } catch (e) {
    console.error('webhook whatsapp :', e.message);
  }
  return NextResponse.json({ received: true });
}
