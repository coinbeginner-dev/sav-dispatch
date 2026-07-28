// ─────────────────────────────────────────────────────────────
// Extraction du statut d'un ticket à partir d'un message libre
// d'un chef d'équipe : français, darija translittérée, ou mélange.
//
// Principe : on ne cherche pas à comprendre la phrase, on cherche
// QUEL ticket parmi ceux attribués aujourd'hui, et QUEL statut.
// L'ensemble des candidats est court et connu, ce qui rend le
// rapprochement robuste même sur un texte approximatif.
// ─────────────────────────────────────────────────────────────

// Retire accents, ponctuation et casse pour comparer des mots
export function normaliser(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Marqueurs de statut. Darija translittérée incluse, telle qu'elle s'écrit
// réellement au clavier (plusieurs orthographes pour un même mot).
const MARQUEURS = [
  { statut: 'fait', mots: [
    'fait', 'faite', 'cloture', 'cloturee', 'termine', 'terminee', 'fini', 'finie',
    'ok', 'done', 'regle', 'reglee', 'resolu', 'resolue', 'depanne',
    'salina', 'sali', 'salit', 'salinah', 'tsalla', 'tsallat', 'khlas', 'khlass',
    'kmlt', 'kmlna', 'daz', 'dazt', 'mchat', 'msha',
  ] },
  { statut: 'pas_acces', mots: [
    'absent', 'absente', 'ferme', 'fermee', 'personne', 'injoignable',
    'makanch', 'makaynch', 'makayn', 'mkanch', 'majawbch', 'majawebch',
    'jawbch', 'jawebch', 'marechch', 'mabghach', 'refus', 'refuse', 'introuvable',
  ], expressions: ['pas d acces', 'pas de reponse', 'pas de contact', 'client absent',
    'personne sur place', 'porte fermee', 'ne repond pas',
    // La négation darija s'écrit aussi bien collée qu'espacée : ma ... ch
    'ma jawbch', 'ma jawebch', 'ma kanch', 'ma kaynch', 'ma bghach', 'ma rechch'] },
  { statut: 'reporte', mots: [
    'reporte', 'reportee', 'demain', 'ghedda', 'ghadda', 'rdv', 'bloque', 'bloquee',
    'attente', 'nacelle', 'cable', 'materiel', 'gc',
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

// Références explicites : R suivi de 6 chiffres ou plus, éventuellement espacés
export function refsCitees(texte, tickets) {
  const connus = new Set(tickets.map((t) => t.ref.toUpperCase()));
  const trouves = [];
  const brut = String(texte || '').toUpperCase();
  for (const m of brut.matchAll(/R\s?(\d[\d\s]{5,})/g)) {
    const ref = 'R' + m[1].replace(/\s/g, '');
    if (connus.has(ref)) trouves.push(ref);
  }
  return [...new Set(trouves)];
}

// Deux mots se correspondent si l'un est le préfixe de l'autre :
// « faculte » retrouve « FACULTED », « lahlou » retrouve « LAHLOU ».
function memeMot(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// Rapprochement par nom de client : on COMPTE les mots distinctifs retrouvés,
// on ne calcule pas une proportion. Un nom d'établissement peut faire six mots
// alors que le chef n'en dira qu'un seul ; exiger la moitié rendrait ces
// tickets impossibles à désigner. Un prénom seul, lui, reste ambigu et c'est
// l'égalité des scores qui le signale.
function scoreClient(motsMessage, client) {
  const motsClient = normaliser(client).split(' ').filter((w) => w.length >= 4);
  let n = 0;
  for (const mc of motsClient) {
    for (const mm of motsMessage) if (memeMot(mc, mm)) { n++; break; }
  }
  return n;
}

// Rapprochement par MSAN / quartier (ex. "taouzar", "colline")
function scoreZone(motsMessage, msan) {
  const morceaux = normaliser(msan).split(' ')
    .flatMap((p) => p.split(/[-_]/))
    .filter((w) => w.length >= 5 && !['casa', 'ville'].includes(w));
  return morceaux.some((w) => motsMessage.has(w)) ? 1 : 0;
}

// Analyse un message contre les tickets du jour attribués à ce chef.
// Retourne les correspondances trouvées, avec un niveau de confiance :
//   'certaine'  → référence de ticket explicitement citée
//   'probable'  → nom de client reconnu sans ambiguïté
//   'ambigue'   → plusieurs tickets possibles, ou zone seule : demander confirmation
export function analyser(texte, tickets) {
  const statut = detecterStatut(texte);
  const motsMessage = new Set(normaliser(texte).split(' '));

  const refs = refsCitees(texte, tickets);
  if (refs.length) {
    return {
      statut,
      confiance: 'certaine',
      candidats: refs.map((ref) => tickets.find((t) => t.ref === ref)),
      raison: 'référence citée',
    };
  }

  const parClient = tickets
    .map((t) => ({ t, s: scoreClient(motsMessage, t.client) }))
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s);

  if (parClient.length === 1) {
    return { statut, confiance: 'probable', candidats: [parClient[0].t], raison: 'nom du client' };
  }
  if (parClient.length > 1) {
    const meilleurs = parClient.filter((x) => x.s === parClient[0].s).map((x) => x.t);
    return {
      statut,
      confiance: meilleurs.length === 1 ? 'probable' : 'ambigue',
      candidats: meilleurs.slice(0, 5),
      raison: 'nom du client',
    };
  }

  const parZone = tickets.filter((t) => scoreZone(motsMessage, t.msan));
  if (parZone.length) {
    return {
      statut,
      confiance: parZone.length === 1 ? 'probable' : 'ambigue',
      candidats: parZone.slice(0, 5),
      raison: 'zone / MSAN',
    };
  }

  return { statut, confiance: 'aucune', candidats: [], raison: 'aucun ticket reconnu' };
}

const LIBELLE = { fait: 'fait', pas_acces: "pas d'accès", reporte: 'reporté' };

// Message de confirmation renvoyé au chef. On ne marque jamais un ticket
// sans accusé : un "fait" posé à tort masquerait un ticket qui court vers la pénalité.
export function messageConfirmation(res) {
  if (!res.statut && !res.candidats.length) {
    return "Je n'ai pas compris de quel ticket il s'agit. Réponds avec le numéro (ex. R341024219) ou le nom du client.";
  }
  if (!res.statut) {
    const t = res.candidats[0];
    return `${t.ref} — ${t.client} : c'est fait, pas d'accès, ou reporté ?`;
  }
  if (res.confiance === 'aucune') {
    return `J'ai compris « ${LIBELLE[res.statut]} », mais pas de quel ticket. Donne-moi le numéro ou le nom du client.`;
  }
  if (res.confiance === 'ambigue') {
    const liste = res.candidats.map((t, i) => `${i + 1}. ${t.ref} — ${t.client}`).join('\n');
    return `Plusieurs tickets correspondent. Lequel est ${LIBELLE[res.statut]} ?\n${liste}`;
  }
  const t = res.candidats[0];
  const suite = res.candidats.length > 1
    ? ` (+${res.candidats.length - 1} autre${res.candidats.length > 2 ? 's' : ''})`
    : '';
  return `${t.ref} — ${t.client} : ${LIBELLE[res.statut]}${suite}. C'est bon ?`;
}

// Le chef confirme-t-il ? (réponse courte, français ou darija)
export function estConfirmation(texte) {
  const n = normaliser(texte);
  const oui = ['oui', 'ok', 'yes', 'exact', 'c est ca', 'cest ca', 'wah', 'wa', 'iyeh', 'ah', 'safi', 'mzyan', 'voila'];
  const non = ['non', 'no', 'pas ca', 'faux', 'la', 'machi', 'machi hadak'];
  if (non.some((m) => n === m || n.startsWith(m + ' '))) return false;
  if (oui.some((m) => n === m || n.startsWith(m + ' '))) return true;
  return null;
}
