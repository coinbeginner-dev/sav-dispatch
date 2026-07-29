// ─────────────────────────────────────────────────────────────
// Couche d'accès aux données côté client.
// Base Postgres si DATABASE_URL est configurée sur Vercel,
// sinon repli automatique sur le localStorage (mode mono-appareil).
// ─────────────────────────────────────────────────────────────
import { DEFAULT_ZONES, DEFAULT_TECHS, DEFAULT_CHEFS, suggestAssignments } from './dispatch';

const LS = {
  techs: 'savd_techs_v1',
  zones: 'savd_zones_v1',
  chef: 'savd_chef_v1',     // ancien format (un seul chef) — migration
  chefs: 'savd_chefs_v1',
  history: 'savd_history_v1',
};

function lsLoad(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function lsSave(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Les lignes venant de Postgres sont en snake_case → forme attendue par l'UI
function fromRow(r) {
  return { ...r, msanKey: r.msan_key ?? r.msanKey ?? '', delai: Number(r.delai) || 0 };
}

function localSettings() {
  let chefs = lsLoad(LS.chefs, null);
  if (!chefs) {
    const old = lsLoad(LS.chef, null);
    chefs = old ? [old] : DEFAULT_CHEFS;
  }
  const techs = lsLoad(LS.techs, DEFAULT_TECHS).map((t) => ({ chef: chefs[0]?.name || '', ...t }));
  return { techs, zones: lsLoad(LS.zones, DEFAULT_ZONES), chefs };
}

// Réglages + dispatch du jour déjà enregistré (autre appareil, rechargement)
export async function loadInitial() {
  try {
    const s = await fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json());
    if (s.db && Array.isArray(s.techs)) {
      let dayData = { tickets: [], assign: {}, reports: {}, statuts: {}, historique: {} };
      try {
        const d = await fetch(`/api/tickets?day=${today()}`, { cache: 'no-store' }).then((r) => r.json());
        if (d.db) dayData = { tickets: (d.tickets || []).map(fromRow), assign: d.assign || {}, reports: d.reports || {}, statuts: d.statuts || {}, historique: d.historique || {} };
      } catch {}
      return { db: true, techs: s.techs, zones: s.zones, chefs: s.chefs, ...dayData };
    }
  } catch {}
  return { db: false, ...localSettings(), tickets: [], assign: {}, reports: {}, statuts: {}, historique: {} };
}

export async function saveSettings(db, techs, zones, chefs) {
  if (db) {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ techs, zones, chefs }),
    });
    if (!r.ok) throw new Error('Enregistrement des réglages impossible');
    return r.json();
  }
  lsSave(LS.techs, techs);
  lsSave(LS.zones, zones);
  lsSave(LS.chefs, chefs);
  return { techs, zones, chefs };
}

// Dépôt du fichier du matin. En base : déduplication par n° de ticket,
// compteur de jours et clôture des tickets disparus du fichier.
export async function pushUpload(db, tickets, zones, techs) {
  if (db) {
    const r = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: today(), tickets }),
    });
    if (!r.ok) throw new Error("Enregistrement du fichier impossible");
    const d = await r.json();
    return {
      tickets: (d.tickets || []).map(fromRow),
      assign: d.assign || {},
      reports: d.reports || {},
      closed: d.closed || 0,
    };
  }
  // Mode local : historique 15 jours dans le navigateur
  const hist = lsLoad(LS.history, {});
  const day = today();
  const reports = {};
  for (const t of tickets) {
    let seen = 0;
    for (const [d, refs] of Object.entries(hist)) if (d !== day && refs.includes(t.ref)) seen++;
    if (seen > 0) reports[t.ref] = seen;
  }
  hist[day] = tickets.map((t) => t.ref);
  const days = Object.keys(hist).sort();
  while (days.length > 15) delete hist[days.shift()];
  lsSave(LS.history, hist);
  return { tickets, assign: suggestAssignments(tickets, zones, techs), reports, closed: 0 };
}

export async function pushAssign(db, refs, tech) {
  if (!db) return;
  await fetch('/api/tickets', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, tech: tech || null, day: today() }),
  });
}

// Arbitrage de l'orienteur : 'planifier' remet le ticket en dispatch,
// 'cloturer' acte qu'il est traité et le sort de la liste.
export async function pushArbitrage(db, refs, decision) {
  if (!db) return;
  await fetch('/api/tickets', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, arbitrage: decision, day: today() }),
  });
}

// Statut terrain. La file locale encaisse les coupures réseau :
// un statut posé hors ligne repart tout seul au retour de la connexion.
const QUEUE = 'savd_statut_queue_v1';

export async function pushStatut(db, refs, statut, motif, texte) {
  if (!db) return;
  const item = { refs, statut: statut || null, motif: motif || null, texte: texte || null, day: today() };
  const queue = lsLoad(QUEUE, []);
  queue.push(item);
  lsSave(QUEUE, queue);
  await flushStatuts();
}

export async function flushStatuts() {
  let queue = lsLoad(QUEUE, []);
  while (queue.length) {
    const item = queue[0];
    try {
      const r = await fetch('/api/tickets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, source: 'chef' }),
      });
      if (!r.ok) return false;
    } catch {
      return false;  // hors ligne : on retentera
    }
    queue = lsLoad(QUEUE, []).slice(1);
    lsSave(QUEUE, queue);
  }
  return true;
}

export function statutsEnAttente() {
  return lsLoad(QUEUE, []).length;
}

export async function loadHistory() {
  const r = await fetch('/api/history', { cache: 'no-store' });
  return r.json();
}
