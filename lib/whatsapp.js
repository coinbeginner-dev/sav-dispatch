// Envoi de messages via l'API WhatsApp Business Cloud.
// Le format libre n'est autorisé que dans la fenêtre de 24 h ouverte par un
// message du destinataire — ce qui est toujours le cas ici, puisqu'on ne fait
// que répondre à un chef qui vient d'écrire.

const API = 'https://graph.facebook.com/v22.0';

export function whatsappConfigure() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export async function envoyerTexte(destinataire, texte) {
  if (!whatsappConfigure()) return { ok: false, erreur: 'WhatsApp non configuré' };
  const url = `${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(destinataire).replace(/\D/g, ''),
        type: 'text',
        text: { preview_url: false, body: texte },
      }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, erreur: d?.error?.message || `HTTP ${r.status}` };
    return { ok: true, id: d?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, erreur: String(e.message || e) };
  }
}
