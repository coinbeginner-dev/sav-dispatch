// ─────────────────────────────────────────────────────────────
// NA (Nouveaux Abonnés / commandes FTTH Connect) — accès Postgres (Neon).
// Module entièrement indépendant du SAV : tables, schéma et logique
// propres (na_*), aucun import ni dépendance vers lib/db.js.
// ─────────────────────────────────────────────────────────────
import { neon } from '@neondatabase/serverless';

export function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

export function useSqlClient(client) {
  _sql = client;
  _ready = null;
}

let _ready = null;
export function ensureSchema() {
  if (!_ready) _ready = init().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function init() {
  const sql = db();
  await sql`create table if not exists na_teams (
    name   text primary key,
    phone  text not null default '',
    active boolean not null default true,
    ord    int  not null default 0
  )`;
  await sql`create table if not exists na_commandes (
    ref            text primary key,
    ref_cflows     text not null default '',
    numero_client  text not null default '',
    operateur      text not null default '',
    sro            text not null default '',
    sro_key        text not null default '',
    type_liaison   text not null default '',
    debit          text not null default '',
    adresse        text not null default '',
    date_reception date,
    first_seen     date not null,
    last_seen      date not null,
    statut         text,
    motif          text,
    texte          text,
    po             text,
    source         text,
    statut_at      timestamptz,
    assigned_team  text,
    assign_manual  boolean not null default false
  )`;
  await sql`create index if not exists na_commandes_statut_idx on na_commandes (statut)`;
  await sql`create index if not exists na_commandes_team_idx on na_commandes (assigned_team)`;

  await sql`create table if not exists na_commande_notes (
    id      bigserial primary key,
    ref     text not null,
    statut  text,
    motif   text,
    texte   text,
    po      text,
    source  text,
    cree_le timestamptz not null default now()
  )`;
  await sql`create index if not exists na_commande_notes_ref_idx on na_commande_notes (ref, cree_le desc)`;
}

// ── Réglages : les 4 équipes NA. Pas de correspondance SRO à configurer —
// elle se déduit automatiquement des affectations déjà faites (voir
// sroApprisDesAffectations ci-dessous), à partir du SRO déjà présent dans
// le fichier Excel de chaque commande.
export async function getSettings() {
  await ensureSchema();
  const sql = db();
  const teams = await sql`select name, phone, active from na_teams order by ord, name`;
  return { teams };
}

export async function saveSettings({ teams = [] }) {
  await ensureSchema();
  const sql = db();
  const cTeams = teams.filter((t) => String(t.name || '').trim());

  await sql`delete from na_teams`;
  await sql`insert into na_teams (name, phone, active, ord) select * from unnest(
    ${cTeams.map((t) => t.name.trim())}::text[],
    ${cTeams.map((t) => t.phone || '')}::text[],
    ${cTeams.map((t) => t.active !== false)}::boolean[],
    ${cTeams.map((_, i) => i)}::int[]
  ) on conflict (name) do nothing`;
  return getSettings();
}

// SRO → équipe appris depuis l'historique : dès qu'une commande d'un SRO
// donné a déjà été affectée (à la main, ou par un dispatch auto précédent)
// à une équipe, toute nouvelle commande du même SRO suit automatiquement
// la même équipe. Pas de table à configurer — l'info vient uniquement du
// SRO déjà présent dans le fichier Excel et des affectations déjà faites.
async function sroApprisDesAffectations() {
  const sql = db();
  const [historique, teams] = await Promise.all([
    sql`
      select sro_key, assigned_team as team, count(*)::int as n
      from na_commandes
      where assigned_team is not null and sro_key <> ''
      group by sro_key, assigned_team
      order by sro_key, n desc`,
    sql`select name from na_teams where active`,
  ]);
  const active = new Set(teams.map((t) => t.name));
  const map = {};
  for (const r of historique) {
    if (!active.has(r.team)) continue;
    if (!(r.sro_key in map)) map[r.sro_key] = r.team; // le plus frequent en premier (order by n desc)
  }
  return map;
}

// Import du fichier "Commandes" : dédup par Réf commande. Une commande déjà
// connue n'est mise à jour que sur ses champs descriptifs (adresse, SRO...) —
// son statut/motif/PO/équipe, une fois posés dans l'appli, ne sont plus
// jamais écrasés par un import de fichier.
export async function importCommandes(commandes, { day, avecStatutDepart = false } = {}) {
  await ensureSchema();
  const sql = db();
  const c = commandes;
  if (!c.length) return { nouvelles: 0, misAJour: 0 };

  const col = (f, d = '') => c.map((x) => (x[f] == null ? d : String(x[f])));
  const statutDepart = c.map((x) => (avecStatutDepart ? x.statutDepart || '' : ''));
  const motifDepart = c.map((x) => (avecStatutDepart ? x.motifDepart || '' : ''));

  const avant = await sql`select ref from na_commandes where ref = any(${c.map((x) => x.ref)}::text[])`;
  const dejaConnues = new Set(avant.map((r) => r.ref));

  const maintenant = new Date().toISOString();
  // Une commande NOUVELLE arrive toujours sans équipe (assigned_team = null) :
  // c'est uniquement le dispatch auto ci-dessous — qui vérifie le plafond de
  // 10 — qui décide de l'affectation. Assigner directement ici depuis le SRO
  // court-circuiterait le plafond pour tout le lot d'un coup.
  const rows = await sql`
    insert into na_commandes (ref, ref_cflows, numero_client, operateur, sro, sro_key,
                              type_liaison, debit, adresse, date_reception, first_seen, last_seen,
                              statut, motif, po, source, statut_at, assigned_team)
    select u.ref, u.refCflows, u.numeroClient, u.operateur, u.sro, u.sroKey,
           u.typeLiaison, u.debit, u.adresse, nullif(u.dateReception, '')::date, ${day}::date, ${day}::date,
           nullif(u.statutDepart, ''), nullif(u.motifDepart, ''),
           null, case when nullif(u.statutDepart, '') is not null then 'seed' else null end,
           case when nullif(u.statutDepart, '') is not null then ${maintenant}::timestamptz else null end,
           null
    from unnest(
      ${col('ref')}::text[], ${col('refCflows')}::text[], ${col('numeroClient')}::text[],
      ${col('operateur')}::text[], ${col('sro')}::text[], ${col('sroKey')}::text[],
      ${col('typeLiaison')}::text[], ${col('debit')}::text[], ${col('adresse')}::text[],
      ${col('dateReception')}::text[], ${statutDepart}::text[], ${motifDepart}::text[]
    ) as u(ref, refCflows, numeroClient, operateur, sro, sroKey,
           typeLiaison, debit, adresse, dateReception, statutDepart, motifDepart)
    on conflict (ref) do update set
      ref_cflows = excluded.ref_cflows, numero_client = excluded.numero_client,
      operateur = excluded.operateur, sro = excluded.sro, sro_key = excluded.sro_key,
      type_liaison = excluded.type_liaison, debit = excluded.debit, adresse = excluded.adresse,
      date_reception = coalesce(na_commandes.date_reception, excluded.date_reception),
      last_seen = greatest(na_commandes.last_seen, excluded.last_seen)
    returning ref, statut, motif, source`;

  // Historique du point de départ (seed) : une seule fois, à l'arrivée du ticket.
  const seedes = rows.filter((r) => r.source === 'seed' && !dejaConnues.has(r.ref));
  if (seedes.length) {
    await sql`
      insert into na_commande_notes (ref, statut, motif, texte, po, source)
      select u.ref, u.statut, nullif(u.motif, ''), null, null, 'seed'
      from unnest(${seedes.map((r) => r.ref)}::text[], ${seedes.map((r) => r.statut)}::text[], ${seedes.map((r) => r.motif || '')}::text[])
        as u(ref, statut, motif)`;
  }

  // Dispatch auto : complète chaque équipe active jusqu'à 10 commandes en
  // cours (statut vide ou planifié — hors fait/annulé/blocage), en piochant
  // les plus anciennes (date de réception) parmi les commandes non affectées
  // dont le SRO a déjà été
  // affecté à une équipe par le passé (sroApprisDesAffectations). Pas de
  // config à tenir : la correspondance SRO -> équipe vient uniquement du SRO
  // déjà present dans le fichier Excel et des affectations déjà faites. Une
  // commande déjà affectée (manuellement ou par un dispatch precedent) n'est
  // jamais réattribuée.
  const CAPACITE = 10;
  const equipes = await sql`select name from na_teams where active order by ord, name`;
  const chargeParEquipe = await sql`
    select assigned_team as team, count(*)::int as n
    from na_commandes
    where assigned_team is not null and (statut is null or statut = 'planifie')
    group by assigned_team`;
  const charge = Object.fromEntries(chargeParEquipe.map((r) => [r.team, r.n]));

  const candidats = await sql`
    select ref, sro_key, date_reception
    from na_commandes
    where assigned_team is null and statut is null
    order by date_reception asc nulls last, ref asc`;

  const map = await sroApprisDesAffectations();
  const parEquipe = {};
  for (const cand of candidats) {
    const team = map[cand.sro_key];
    if (!team) continue;
    (parEquipe[team] = parEquipe[team] || []).push(cand.ref);
  }

  const aAffecter = [];
  for (const eq of equipes) {
    const dejaCharge = charge[eq.name] || 0;
    const place = Math.max(0, CAPACITE - dejaCharge);
    const pool = parEquipe[eq.name] || [];
    for (const ref of pool.slice(0, place)) aAffecter.push({ ref, team: eq.name });
  }

  if (aAffecter.length) {
    await sql`
      update na_commandes n set assigned_team = u.team
      from unnest(${aAffecter.map((a) => a.ref)}::text[], ${aAffecter.map((a) => a.team)}::text[]) as u(ref, team)
      where n.ref = u.ref`;
  }

  return {
    nouvelles: rows.filter((r) => !dejaConnues.has(r.ref)).length,
    misAJour: rows.filter((r) => dejaConnues.has(r.ref)).length,
    dispatchees: aAffecter.length,
  };
}

// Vue d'ensemble : toutes les commandes non closes (statut null/blocage) +
// celles closes récemment (fait/annulé), avec leur équipe et leur historique.
export async function getVue() {
  await ensureSchema();
  const sql = db();
  const commandes = await sql`
    select ref, ref_cflows, numero_client, operateur, sro, sro_key, type_liaison, debit,
           adresse, date_reception::text as date_reception, first_seen::text as first_seen,
           statut, motif, texte, po, source, statut_at, assigned_team, assign_manual
    from na_commandes
    order by date_reception asc nulls last, ref`;
  const notes = await sql`
    select ref, statut, motif, texte, po, source, to_char(cree_le, 'DD/MM HH24:MI') as le
    from na_commande_notes order by cree_le desc`;
  const historique = {};
  for (const n of notes) (historique[n.ref] = historique[n.ref] || []).push(n);
  return { commandes, historique };
}

export const STATUTS = ['fait', 'annule', 'blocage', 'planifie'];

// Pose un statut : 'fait' (avec PO), 'blocage' (avec motif + éventuel texte
// libre), 'annule'. null = annulation de la saisie (redevient actif).
export async function setStatut(refs, statut, { motif = null, texte = null, po = null, source = 'chef' } = {}) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  if (statut && !STATUTS.includes(statut)) throw new Error(`statut inconnu : ${statut}`);

  const at = statut ? new Date().toISOString() : null;
  const rows = await sql`
    update na_commandes set
      statut = ${statut || null},
      motif = ${statut ? motif : null},
      texte = ${statut ? texte : null},
      po = ${statut ? po : null},
      source = ${statut ? source : null},
      statut_at = ${at}::timestamptz
    where ref = any(${list}::text[])
    returning ref`;

  if (statut && rows.length) {
    await sql`
      insert into na_commande_notes (ref, statut, motif, texte, po, source)
      select u.ref, ${statut}, ${motif}, ${texte}, ${po}, ${source}
      from unnest(${rows.map((r) => r.ref)}::text[]) as u(ref)`;
  }
  return { ok: true, updated: rows.length };
}

// Réaffectation manuelle : prioritaire et définitive, l'auto-dispatch ne la
// touche plus jamais (il ne considère que les commandes sans équipe).
export async function assignTeam(refs, team) {
  await ensureSchema();
  const sql = db();
  const list = Array.isArray(refs) ? refs : [refs];
  await sql`update na_commandes set assigned_team = ${team || null}, assign_manual = true
            where ref = any(${list}::text[])`;
  return { ok: true, updated: list.length };
}

export async function getHistorique(refs) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return {};
  const rows = await sql`
    select ref, statut, motif, texte, po, source, to_char(cree_le, 'DD/MM HH24:MI') as le
    from na_commande_notes where ref = any(${list}::text[])
    order by cree_le desc`;
  const parRef = {};
  for (const r of rows) (parRef[r.ref] = parRef[r.ref] || []).push(r);
  return parRef;
}
