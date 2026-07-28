// ─────────────────────────────────────────────────────────────
// Lecture des retours des chefs d'équipe sur WhatsApp.
//
// Règle absolue : un statut n'est retenu QUE si le message contient le
// numéro de ticket exact. Pas de rapprochement par nom de client — un même
// client peut avoir plusieurs tickets ouverts, et marquer « fait » le mauvais
// masquerait un ticket qui court vers la pénalité. Pas de note vocale non plus.
// Une ligne par ticket ; les lignes sans numéro sont signalées, jamais devinées.
// ─────────────────────────────────────────────────────────────

export function normaliser(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Marqueurs de statut, français et darija translittérée telle qu'elle
// s'écrit réellement au clavier.
const MARQUEURS = [
  { statut: 'fait', mots: [
    'fait', 'faite', 'cloture', 'cloturee', 'termine', 'terminee', 'fini', 'finie',
    'ok', 'done', 'regle', 'reglee', 'resolu', 'resolue', 'depanne',
    'salina', 'sali', 'salit', 'tsalla', 'khlas', 'khlass', 'kmlt', 'kmlna',
  ] },
  { statut: 'pas_acces', mots: [
    'absent', 'absente', 'ferme', 'fermee', 'injoignable', 'introuvable',
    'makanch', 'makaynch', 'mkanch', 'majawbch', 'jawbch', 'refus', 'refuse',
  ], expressions: ['pas d acces', 'pas de reponse', 'pas de contact', 'client absent',
    'personne sur place', 'porte fermee', 'ne repond pas',
    'ma jawbch', 'ma kanch', 'ma kaynch'] },
  { statut: 'reporte', mots: [
    'reporte', 'reportee', 'demain', 'ghedda', 'ghadda', 'rdv', 'bloque', 'bloquee',
    'nacelle', 'cable', 'materiel',
  ], expressions: ['a reporter', 'pas encore', 'rendez vous', 'a replanifier'] },
];

export function detecterStatut(texte) {
  const n = normaliser(texte);
  const mots = new Set(n.split(' '));
  for (const m of MARQUEURS) {
    for (const e of m.expressions || []) if (n.includes(e)) return m.statut;
  }
  for (const m of MARQUEURS) {
    for (const mot of m.mots) if (mots.has(mot)) return m.statut;
  }
  return null;
}

// Numéros de ticket cités. Format strict : la lettre R suivie des chiffres,
// et le ticket doit exister dans la journée en cours.
export function refsCitees(texte, tickets) {
  const connus = new Set(tickets.map((t) => t.ref.toUpperCase()));
  const trouves = [];
  for (const m of String(texte || '').toUpperCase().matchAll(/\bR\d{6,}\b/g)) {
    if (connus.has(m[0])) trouves.push(m[0]);
  }
  return [...new Set(trouves)];
}

// Analyse un message, ligne par ligne : une ligne = un ticket.
// Retourne les instructions exploitables et les lignes à faire reformuler.
export function analyser(texte, tickets) {
  const parRef = new Map(tickets.map((t) => [t.ref, t]));
  const instructions = [];
  const ignorees = [];

  for (const ligne of String(texte || '').split(/[\n;]+/).map((l) => l.trim()).filter(Boolean)) {
    const refs = refsCitees(ligne, tickets);
    if (!refs.length) { ignorees.push(ligne); continue; }
    const statut = detecterStatut(ligne);
    for (const ref of refs) {
      instructions.push({ ref, ticket: parRef.get(ref), statut, note: ligne });
    }
  }
  return { instructions, ignorees };
}

const LIBELLE = { fait: 'fait', pas_acces: "pas d'accès", reporte: 'reporté' };

// Réponse renvoyée au chef. On ne écrit jamais sans accusé de sa part.
export function messageConfirmation(res, typeMessage = 'text') {
  if (typeMessage !== 'text') {
    return 'Merci d’écrire le retour en texte, avec le numéro de ticket. '
      + 'Exemple : R341024219 fait';
  }
  const lignes = [];
  const prets = res.instructions.filter((i) => i.statut);
  const sansStatut = res.instructions.filter((i) => !i.statut);

  for (const i of prets) {
    lignes.push(`${i.ref} — ${i.ticket.client} : ${LIBELLE[i.statut]}`);
  }
  for (const i of sansStatut) {
    lignes.push(`${i.ref} — ${i.ticket.client} : fait, pas d’accès, ou reporté ?`);
  }
  if (res.ignorees.length) {
    lignes.push(`Sans numéro de ticket, je ne peux rien enregistrer : «${res.ignorees.join(' / ')}». `
      + 'Renvoie avec le numéro, exemple : R341024219 fait');
  }
  if (!lignes.length) {
    return 'Envoie le numéro de ticket et son statut. Exemple : R341024219 fait';
  }
  if (prets.length && !sansStatut.length && !res.ignorees.length) {
    lignes.push("C'est bon ?");
  }
  return lignes.join('\n');
}

// Le chef confirme-t-il ? (réponse courte, français ou darija)
export function estConfirmation(texte) {
  const n = normaliser(texte);
  const oui = ['oui', 'ok', 'yes', 'exact', 'c est ca', 'cest ca', 'wah', 'iyeh', 'safi', 'mzyan', 'voila'];
  const non = ['non', 'no', 'pas ca', 'faux', 'machi'];
  if (non.some((m) => n === m || n.startsWith(m + ' '))) return false;
  if (oui.some((m) => n === m || n.startsWith(m + ' '))) return true;
  return null;
}
