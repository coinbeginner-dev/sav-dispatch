// ─────────────────────────────────────────────────────────────
// NA (Nouveaux Abonnés / commandes FTTH Connect) — logique métier :
// parsing du fichier "Commandes", SLA 48h, dispatch auto par SRO.
// Module totalement indépendant du SAV (aucun import croisé).
// ─────────────────────────────────────────────────────────────

export const DEFAULT_TEAMS = [];
export const DEFAULT_SRO = [];

// Normalise une clé SRO pour le matching (comme normMsan côté SAV).
export function normSro(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function findCol(headers, ...fragments) {
  const H = headers.map((h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim());
  for (const frag of fragments) {
    const i = H.findIndex((h) => h.includes(frag));
    if (i !== -1) return i;
  }
  return -1;
}

// Convertit une date Excel (numéro série ou texte "JJ/MM/AAAA HH:MM") en ISO (date seule).
function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 40000) {
    return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function cleanAddr(a) {
  return String(a || '')
    .replace(/^Province\s+/i, '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

// Correspondance statut fichier (colonnes de démarrage, absentes des imports
// suivants) → vocabulaire interne de l'appli.
const STATUT_FICHIER = {
  'intervention terminée': 'fait',
  'annulée': 'annule',
  'blocage': 'blocage',
  // "en cours" et tout le reste → pas de statut (actif, en file d'attente)
};

// Parse la feuille "Commandes". Les colonnes Statut Connect / Status Rafik
// (statut de démarrage) sont lues automatiquement si elles existent dans le
// fichier — absentes des imports suivants, où tout passe par les statuts
// posés dans l'appli. Pas besoin de bascule manuelle : la présence de la
// colonne suffit à savoir si on est sur l'import de démarrage.
export function parseCommandes(rows) {
  if (!rows || rows.length < 2) return { commandes: [], errors: [], avecStatutDepart: false };
  const headers = rows[0];
  const col = {
    ref: findCol(headers, 'réf commande', 'reference commande'),
    refCflows: findCol(headers, 'cflows'),
    numeroClient: findCol(headers, 'numero client', 'numéro client'),
    operateur: findCol(headers, 'opérateur', 'operateur'),
    sro: findCol(headers, 'sro'),
    typeLiaison: findCol(headers, 'type liaison'),
    debit: findCol(headers, 'débit', 'debit'),
    adresse: findCol(headers, 'adresse'),
    dateReception: findCol(headers, 'réception commande', 'reception commande'),
    statutConnect: findCol(headers, 'statut connect'),
    statusRafik: findCol(headers, 'status rafik', 'statut rafik'),
  };

  const errors = [];
  if (col.ref === -1) errors.push("Colonne 'Réf commande' introuvable");
  if (col.dateReception === -1) errors.push("Colonne 'Date réception commande' introuvable — le SLA 48h ne peut pas se calculer");
  if (errors.length) return { commandes: [], errors, avecStatutDepart: false };

  const avecStatutDepart = col.statutConnect !== -1;
  const commandes = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[col.ref] == null || String(r[col.ref]).trim() === '') continue;
    const ref = String(r[col.ref]).trim();

    const sro = col.sro !== -1 ? String(r[col.sro] || '').trim() : '';
    const c = {
      ref,
      refCflows: col.refCflows !== -1 ? String(r[col.refCflows] || '').trim() : '',
      numeroClient: col.numeroClient !== -1 ? String(r[col.numeroClient] || '').trim() : '',
      operateur: col.operateur !== -1 ? String(r[col.operateur] || '').trim() : '',
      sro,
      sroKey: normSro(sro),
      typeLiaison: col.typeLiaison !== -1 ? String(r[col.typeLiaison] || '').trim() : '',
      debit: col.debit !== -1 ? String(r[col.debit] || '').trim() : '',
      adresse: col.adresse !== -1 ? cleanAddr(r[col.adresse]) : '',
      dateReception: col.dateReception !== -1 ? toIsoDate(r[col.dateReception]) : null,
    };

    if (avecStatutDepart) {
      const brut = col.statutConnect !== -1 ? String(r[col.statutConnect] || '').trim().toLowerCase() : '';
      c.statutDepart = STATUT_FICHIER[brut] || null;
      c.motifDepart = col.statusRafik !== -1 ? String(r[col.statusRafik] || '').trim() || null : null;
    }

    commandes.push(c);
  }

  const seen = new Set();
  const uniq = [];
  let dups = 0;
  for (const c of commandes) {
    if (seen.has(c.ref)) { dups++; continue; }
    seen.add(c.ref);
    uniq.push(c);
  }
  if (dups) errors.push(`${dups} doublon(s) supprimé(s)`);
  return { commandes: uniq, errors, avecStatutDepart };
}

// SLA 48h depuis la date de réception. >=48h : rouge (dépassé) ·
// >=24h : orange · <24h : vert. `reception` = date ISO (YYYY-MM-DD).
export function slaClass(reception, maintenant = new Date()) {
  if (!reception) return { key: 'vert', label: 'Date inconnue', color: '#00753A', bg: '#EAFAF1', heures: 0 };
  const debut = new Date(`${reception}T00:00:00`);
  const heures = (maintenant - debut) / 3_600_000;
  if (heures >= 48) return { key: 'rouge', label: `${Math.floor(heures / 24)}j · SLA dépassé`, color: '#C0392B', bg: '#FEF2F2', heures };
  if (heures >= 24) return { key: 'orange', label: `${Math.floor(heures)}h · 24-48h`, color: '#B87700', bg: '#FFF8EC', heures };
  return { key: 'vert', label: `${Math.floor(heures)}h · < 24h`, color: '#00753A', bg: '#EAFAF1', heures };
}

// Suggestion d'équipe par SRO (équivalent MSAN→équipe côté SAV).
export function suggestTeamBySro(commandes, sroZones, teams) {
  const zoneMap = {};
  for (const z of sroZones) zoneMap[normSro(z.sro)] = z.team;
  const activeNames = new Set(teams.filter((t) => t.active).map((t) => t.name));
  const out = {};
  for (const c of commandes) {
    const team = zoneMap[c.sroKey];
    out[c.ref] = team && activeNames.has(team) ? team : null;
  }
  return out;
}

export function waLinkNa(phone, text) {
  const p = String(phone || '').replace(/[^\d]/g, '');
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

// ── Messages WhatsApp ────────────────────────────────────────
export function buildTeamMessage(teamName, commandes, dateStr) {
  const lines = [`📡 *NA FTTH — ${dateStr}*`, `Équipe : *${teamName}*`, '', `${commandes.length} commande(s)`, ''];
  let n = 0;
  for (const c of commandes) {
    n++;
    const sla = slaClass(c.dateReception);
    const emo = sla.key === 'rouge' ? '🔴' : sla.key === 'orange' ? '🟠' : '🟢';
    lines.push(`*${n}. ${c.ref}* ${emo} ${sla.label}`);
    if (c.adresse) lines.push(`   📍 ${c.adresse}`);
    if (c.sro) lines.push(`   🔌 SRO ${c.sro}`);
    lines.push('');
  }
  return lines.join('\n');
}
