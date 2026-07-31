// ─────────────────────────────────────────────────────────────
// Couche d'accès aux données côté client pour le module NA.
// Indépendant de lib/store.js (SAV) : aucun import croisé.
// ─────────────────────────────────────────────────────────────

export async function loadInitial() {
  try {
    const s = await fetch('/api/na/settings', { cache: 'no-store' }).then((r) => r.json());
    if (s.db && Array.isArray(s.teams)) {
      const d = await fetch('/api/na/commandes', { cache: 'no-store' }).then((r) => r.json());
      return {
        db: true, teams: s.teams,
        commandes: d.db ? d.commandes || [] : [],
        historique: d.db ? d.historique || {} : {},
      };
    }
  } catch {}
  return { db: false, teams: [], commandes: [], historique: {} };
}

export async function saveSettings(db, teams) {
  if (!db) return { teams };
  const r = await fetch('/api/na/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teams }),
  });
  if (!r.ok) throw new Error('Enregistrement des réglages NA impossible');
  return r.json();
}

// Import du fichier "Commandes". `avecStatutDepart` : true uniquement pour
// le tout premier import (colonnes Statut Connect / Status Rafik présentes).
export async function pushImport(db, commandes, avecStatutDepart) {
  if (!db) return { commandes: [], historique: {} };
  const r = await fetch('/api/na/commandes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandes, avecStatutDepart }),
  });
  if (!r.ok) throw new Error("Import impossible");
  return r.json();
}

export async function pushStatut(db, refs, statut, extra = {}) {
  if (!db) return;
  await fetch('/api/na/commandes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, statut, ...extra }),
  });
}

export async function pushAssign(db, refs, team) {
  if (!db) return;
  await fetch('/api/na/commandes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, team: team || null }),
  });
}
