// ─────────────────────────────────────────────────────────────
// Accès Postgres (Neon) — schéma, seed et requêtes métier.
// Sans DATABASE_URL l'app retombe sur le localStorage côté client.
// ─────────────────────────────────────────────────────────────
import { neon } from '@neondatabase/serverless';
import { DEFAULT_ZONES, DEFAULT_TECHS, DEFAULT_CHEFS, normMsan } from './dispatch.js';

export function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Branche un client SQL de substitution (tests : Postgres embarqué PGlite)
export function useSqlClient(client) {
  _sql = client;
  _ready = null;
}

let _ready = null;
// Crée le schéma si absent puis seed les réglages par défaut (une fois par instance).
export function ensureSchema() {
  if (!_ready) _ready = init().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function init() {
  const sql = db();
  await sql`create table if not exists chefs (
    name  text primary key,
    phone text not null default '',
    ord   int  not null default 0
  )`;
  await sql`create table if not exists techs (
    name   text primary key,
    phone  text not null default '',
    active boolean not null default true,
    chef   text not null default '',
    ord    int  not null default 0
  )`;
  await sql`create table if not exists zones (
    msan_key text primary key,
    msan     text not null,
    tech     text not null default '',
    ord      int  not null default 0
  )`;
  await sql`create table if not exists tickets (
    ref           text primary key,
    nd            text not null default '',
    client        text not null default '',
    msan          text not null default '',
    msan_key      text not null default '',
    enreg         text not null default '',
    delai         numeric not null default 0,
    famille       text not null default '',
    contact       text not null default '',
    adresse       text not null default '',
    avancement    text not null default '',
    tranche       text not null default '',
    splitter      text,
    first_seen    date not null,
    last_seen     date not null,
    days_seen     int  not null default 1,
    status        text not null default 'ouvert',
    assigned_tech text,
    assign_manual boolean not null default false,
    closed_on     date
  )`;
  await sql`create table if not exists ticket_days (
    ref           text not null,
    day           date not null,
    delai         numeric not null default 0,
    assigned_tech text,
    tranche       text not null default '',
    primary key (ref, day)
  )`;
  await sql`create index if not exists ticket_days_day_idx on ticket_days (day)`;
  await sql`create index if not exists tickets_status_idx on tickets (status, last_seen)`;

  // Journal des messages WhatsApp entrants. Sert d'abord de banc d'essai :
  // on collecte de vrais messages (texte, vocal darija, photo) avant d'automatiser.
  await sql`create table if not exists wa_messages (
    id          bigserial primary key,
    wa_message_id text unique,
    de          text not null default '',
    nom         text not null default '',
    type        text not null default '',
    texte       text,
    media_id    text,
    recu_le     timestamptz not null default now(),
    traite      boolean not null default false,
    raw         jsonb
  )`;
  await sql`create index if not exists wa_messages_recu_idx on wa_messages (recu_le desc)`;

  // Accuses de statut des messages SORTANTS (sent / delivered / read / failed).
  // Indispensable au diagnostic : un envoi qui n'arrive pas laisse ici son motif d'echec.
  await sql`create table if not exists wa_statuses (
    id           bigserial primary key,
    message_id   text,
    destinataire text not null default '',
    statut       text not null default '',
    erreur_code  text,
    erreur_titre text,
    recu_le      timestamptz not null default now()
  )`;
  await sql`create index if not exists wa_statuses_recu_idx on wa_statuses (recu_le desc)`;

  // Journal de diagnostic : trace tout appel recu sur le webhook, meme rejete.
  // Ne stocke aucun contenu, seulement de quoi distinguer "Meta n'appelle pas"
  // de "Meta appelle mais la signature ne passe pas".
  await sql`create table if not exists wa_hits (
    id        bigserial primary key,
    recu_le   timestamptz not null default now(),
    signature text not null default '',
    taille    int not null default 0,
    resultat  text not null default ''
  )`;

  // Suivi intra-journée : statut declare par le terrain, jour par jour.
  // Alimente aujourd'hui par le chef depuis le tableau de bord, demain par le bot WhatsApp.
  await sql`alter table ticket_days add column if not exists statut    text`;
  await sql`alter table ticket_days add column if not exists motif     text`;
  await sql`alter table ticket_days add column if not exists statut_at timestamptz`;
  await sql`alter table ticket_days add column if not exists source    text`;

  // Arbitrage du matin : un ticket deja renseigne un jour precedent revient
  // dans le fichier. Il est exclu du dispatch par defaut — envoyer une equipe
  // sur une intervention deja faite coute une demi-journee — et l'orienteur
  // decide de le replanifier ou non.
  await sql`alter table ticket_days add column if not exists hors_dispatch  boolean not null default false`;
  await sql`alter table ticket_days add column if not exists arbitrage      text`;
  await sql`alter table ticket_days add column if not exists arbitrage_motif text`;
  await sql`alter table ticket_days add column if not exists arbitrage_le   date`;
  // Arbitrage tranché par l'orienteur : sa décision survit aux rechargements
  // du fichier, comme une réaffectation manuelle.
  await sql`alter table ticket_days add column if not exists arbitrage_decide boolean not null default false`;

  // Seed initial : réglages par défaut si la base est vierge
  const [{ n }] = await sql`select count(*)::int as n from techs`;
  if (n === 0) await seedDefaults();
}

async function seedDefaults() {
  const sql = db();
  await sql`insert into chefs (name, phone, ord)
    select * from unnest(
      ${DEFAULT_CHEFS.map((c) => c.name)}::text[],
      ${DEFAULT_CHEFS.map((c) => c.phone || '')}::text[],
      ${DEFAULT_CHEFS.map((_, i) => i)}::int[]
    ) on conflict (name) do nothing`;
  await sql`insert into techs (name, phone, active, chef, ord)
    select * from unnest(
      ${DEFAULT_TECHS.map((t) => t.name)}::text[],
      ${DEFAULT_TECHS.map((t) => t.phone || '')}::text[],
      ${DEFAULT_TECHS.map((t) => t.active !== false)}::boolean[],
      ${DEFAULT_TECHS.map((t) => t.chef || '')}::text[],
      ${DEFAULT_TECHS.map((_, i) => i)}::int[]
    ) on conflict (name) do nothing`;
  await sql`insert into zones (msan_key, msan, tech, ord)
    select * from unnest(
      ${DEFAULT_ZONES.map((z) => normMsan(z.msan))}::text[],
      ${DEFAULT_ZONES.map((z) => z.msan)}::text[],
      ${DEFAULT_ZONES.map((z) => z.tech || '')}::text[],
      ${DEFAULT_ZONES.map((_, i) => i)}::int[]
    ) on conflict (msan_key) do nothing`;
}

// ── Réglages ────────────────────────────────────────────────
export async function getSettings() {
  await ensureSchema();
  const sql = db();
  const [techs, zones, chefs] = await Promise.all([
    sql`select name, phone, active, chef from techs order by ord, name`,
    sql`select msan, tech from zones order by ord, msan`,
    sql`select name, phone from chefs order by ord, name`,
  ]);
  return { techs, zones, chefs };
}

// Remplace intégralement les réglages (le formulaire envoie l'état complet).
export async function saveSettings({ techs = [], zones = [], chefs = [] }) {
  await ensureSchema();
  const sql = db();
  const cTechs = techs.filter((t) => String(t.name || '').trim());
  const cZones = zones.filter((z) => String(z.msan || '').trim());
  const cChefs = chefs.filter((c) => String(c.name || '').trim());

  await sql.transaction([
    sql`delete from chefs`,
    sql`insert into chefs (name, phone, ord) select * from unnest(
      ${cChefs.map((c) => c.name.trim())}::text[],
      ${cChefs.map((c) => c.phone || '')}::text[],
      ${cChefs.map((_, i) => i)}::int[]
    ) on conflict (name) do nothing`,
    sql`delete from techs`,
    sql`insert into techs (name, phone, active, chef, ord) select * from unnest(
      ${cTechs.map((t) => t.name.trim())}::text[],
      ${cTechs.map((t) => t.phone || '')}::text[],
      ${cTechs.map((t) => t.active !== false)}::boolean[],
      ${cTechs.map((t) => t.chef || '')}::text[],
      ${cTechs.map((_, i) => i)}::int[]
    ) on conflict (name) do nothing`,
    sql`delete from zones`,
    sql`insert into zones (msan_key, msan, tech, ord) select * from unnest(
      ${cZones.map((z) => normMsan(z.msan))}::text[],
      ${cZones.map((z) => z.msan.trim())}::text[],
      ${cZones.map((z) => z.tech || '')}::text[],
      ${cZones.map((_, i) => i)}::int[]
    ) on conflict (msan_key) do update set msan = excluded.msan, tech = excluded.tech, ord = excluded.ord`,
  ]);
  return getSettings();
}

// ── Tickets ─────────────────────────────────────────────────
// Affectation suggérée : MSAN → technicien actif (réglages en base)
async function suggestMap() {
  const sql = db();
  const [zones, techs] = await Promise.all([
    sql`select msan_key, tech from zones`,
    sql`select name from techs where active`,
  ]);
  const active = new Set(techs.map((t) => t.name));
  const map = {};
  for (const z of zones) if (z.tech && active.has(z.tech)) map[z.msan_key] = z.tech;
  return map;
}

// Enregistre le fichier du jour : upsert dédupliqué par n° de ticket,
// incrément du compteur de jours, clôture des tickets disparus du fichier.
export async function saveUpload(day, tickets) {
  await ensureSchema();
  const sql = db();
  const suggest = await suggestMap();

  const t = tickets;
  const col = (f, d = '') => t.map((x) => (x[f] == null ? d : String(x[f])));
  const suggested = t.map((x) => suggest[x.msanKey] || '');

  if (t.length) {
    await sql`
      insert into tickets (ref, nd, client, msan, msan_key, enreg, delai, famille, contact,
                           adresse, avancement, tranche, splitter, first_seen, last_seen,
                           days_seen, status, assigned_tech)
      select u.ref, u.nd, u.client, u.msan, u.msan_key, u.enreg, u.delai, u.famille, u.contact,
             u.adresse, u.avancement, u.tranche, nullif(u.splitter, ''), ${day}::date, ${day}::date,
             1, 'ouvert', nullif(u.tech, '')
      from unnest(
        ${col('ref')}::text[], ${col('nd')}::text[], ${col('client')}::text[],
        ${col('msan')}::text[], ${col('msanKey')}::text[], ${col('enreg')}::text[],
        ${t.map((x) => Number(x.delai) || 0)}::numeric[], ${col('famille')}::text[],
        ${col('contact')}::text[], ${col('adresse')}::text[], ${col('avancement')}::text[],
        ${col('tranche')}::text[], ${col('splitter')}::text[], ${suggested}::text[]
      ) as u(ref, nd, client, msan, msan_key, enreg, delai, famille, contact,
             adresse, avancement, tranche, splitter, tech)
      on conflict (ref) do update set
        nd = excluded.nd, client = excluded.client, msan = excluded.msan,
        msan_key = excluded.msan_key, enreg = excluded.enreg, delai = excluded.delai,
        famille = excluded.famille, contact = excluded.contact, adresse = excluded.adresse,
        avancement = excluded.avancement, tranche = excluded.tranche, splitter = excluded.splitter,
        last_seen = greatest(tickets.last_seen, excluded.last_seen),
        days_seen = tickets.days_seen + case when tickets.last_seen < excluded.last_seen then 1 else 0 end,
        status = 'ouvert', closed_on = null,
        assigned_tech = case when tickets.assign_manual then tickets.assigned_tech
                             else excluded.assigned_tech end`;

    await sql`
      insert into ticket_days (ref, day, delai, assigned_tech, tranche)
      select u.ref, ${day}::date, u.delai, nullif(u.tech, ''), u.tranche
      from unnest(
        ${col('ref')}::text[], ${t.map((x) => Number(x.delai) || 0)}::numeric[],
        ${suggested}::text[], ${col('tranche')}::text[]
      ) as u(ref, delai, tech, tranche)
      on conflict (ref, day) do update set delai = excluded.delai, tranche = excluded.tranche`;
  }

  // Arbitrage : tout ticket qui a DEJA un statut, quel que soit le jour ou il
  // a ete pose, sort du dispatch. Ce qui compte c'est qu'il soit renseigne,
  // pas la date : recharger le fichier en cours de journee doit produire le
  // meme arbitrage que le chargement du lendemain.
  // On reprend le dernier statut connu et son motif, pour que l'orienteur
  // decide en connaissance de cause au lieu de redistribuer a l'aveugle.
  // Une decision deja prise par l'orienteur n'est jamais rejouee.
  if (t.length) {
    await sql`
      with dernier as (
        select distinct on (ref) ref, statut, motif, day
        from ticket_days
        where statut is not null
        order by ref, day desc
      )
      update ticket_days d set
        hors_dispatch = true,
        arbitrage = dernier.statut,
        arbitrage_motif = dernier.motif,
        arbitrage_le = dernier.day
      from dernier
      where d.day = ${day}::date and d.ref = dernier.ref and not d.arbitrage_decide`;
  }

  // Tickets ouverts absents du fichier du jour → considérés traités
  const closed = await sql`
    update tickets set status = 'clos', closed_on = ${day}::date
    where status = 'ouvert' and last_seen < ${day}::date
    returning ref`;

  const rows = await getDay(day);
  return { ...rows, closed: closed.length };
}

// Tickets du jour + affectations + compteur de reports (jours antérieurs vus)
export async function getDay(day) {
  await ensureSchema();
  const sql = db();
  const tickets = await sql`
    select t.ref, t.nd, t.client, t.msan, t.msan_key, t.enreg, t.delai::float8 as delai,
           t.famille, t.contact, t.adresse, t.avancement, t.tranche, t.splitter,
           t.days_seen, t.status, t.assigned_tech, t.assign_manual,
           t.first_seen::text as first_seen,
           d.statut, d.motif, d.source, d.statut_at,
           d.hors_dispatch, d.arbitrage, d.arbitrage_motif,
           d.arbitrage_le::text as arbitrage_le
    from tickets t
    join ticket_days d on d.ref = t.ref and d.day = ${day}::date
    order by t.delai desc, t.ref`;
  const reps = await sql`
    select d.ref, count(*)::int as n from ticket_days d
    where d.day < ${day}::date
      and d.ref in (select ref from ticket_days where day = ${day}::date)
    group by d.ref`;

  const assign = {};
  const reports = {};
  const statuts = {};
  for (const t of tickets) {
    assign[t.ref] = t.assigned_tech || null;
    if (t.statut) statuts[t.ref] = { statut: t.statut, motif: t.motif, source: t.source, at: t.statut_at };
  }
  for (const r of reps) reports[r.ref] = r.n;
  return { day, tickets, assign, reports, statuts };
}

// Réaffectation manuelle (mémorisée : l'upload suivant ne l'écrase pas)
export async function assignTickets(refs, tech, day) {
  await ensureSchema();
  const sql = db();
  const list = Array.isArray(refs) ? refs : [refs];
  const val = tech || null;
  await sql`update tickets set assigned_tech = ${val}, assign_manual = true
            where ref = any(${list}::text[])`;
  if (day) {
    await sql`update ticket_days set assigned_tech = ${val}
              where day = ${day}::date and ref = any(${list}::text[])`;
  }
  return { ok: true, updated: list.length };
}

// Statuts terrain acceptés. null / absent = en attente.
export const STATUTS = ['fait', 'pas_acces', 'reporte'];

// Marque le statut d'un ou plusieurs tickets pour une journée.
// `source` trace qui l'a saisi : 'chef' (tableau de bord) ou 'whatsapp' (remontée technicien).
export async function setStatut(refs, statut, { day, motif = null, source = 'chef' } = {}) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  if (statut && !STATUTS.includes(statut)) throw new Error(`statut inconnu : ${statut}`);

  const at = statut ? new Date().toISOString() : null;
  const rows = await sql`
    update ticket_days set
      statut = ${statut || null},
      motif = ${statut ? motif : null},
      source = ${statut ? source : null},
      statut_at = ${at}::timestamptz
    where day = ${day}::date and ref = any(${list}::text[])
    returning ref`;
  return { ok: true, updated: rows.length };
}

// L'orienteur remet un ticket arbitré dans le dispatch (ou l'en ressort).
export async function planifier(refs, day, dedans = true) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  const rows = await sql`
    update ticket_days set hors_dispatch = ${!dedans}, arbitrage_decide = true
    where day = ${day}::date and ref = any(${list}::text[])
    returning ref`;
  return { ok: true, updated: rows.length };
}

// Avancement du jour par technicien (barre de progression du tableau de bord)
export async function getAvancement(day) {
  await ensureSchema();
  const sql = db();
  return sql`
    select coalesce(assigned_tech, '—') as tech,
           count(*)::int as total,
           count(*) filter (where statut = 'fait')::int as fait,
           count(*) filter (where statut = 'pas_acces')::int as pas_acces,
           count(*) filter (where statut = 'reporte')::int as reporte,
           count(*) filter (where statut is null and delai >= 2)::int as rouges_en_attente
    from ticket_days where day = ${day}::date
    group by 1 order by 1`;
}

// Ecart entre le declaratif du terrain et le fichier du lendemain :
// ticket declare "fait" la veille mais toujours present ce matin
// = intervention realisee mais non clôturee/qualifiee cote IAM.
export async function getEcarts(day) {
  await ensureSchema();
  const sql = db();
  return sql`
    select d.ref, t.client, t.msan, t.assigned_tech, d.day::text as declare_le,
           d.motif, t.delai::float8 as delai
    from ticket_days d
    join ticket_days aujourdhui on aujourdhui.ref = d.ref and aujourdhui.day = ${day}::date
    join tickets t on t.ref = d.ref
    where d.day < ${day}::date and d.statut = 'fait'
    order by t.delai desc`;
}

// ── Rattachement d'un numéro WhatsApp à un chef d'équipe ────
// On compare les 9 derniers chiffres : le chef peut être enregistré en
// 0612345678 ou 212612345678, WhatsApp renvoie toujours l'international.
function neufDerniers(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

export async function chefParTelephone(tel) {
  await ensureSchema();
  const cle = neufDerniers(tel);
  if (!cle) return null;
  const rows = await db()`select name, phone from chefs where phone <> ''`;
  return rows.find((c) => neufDerniers(c.phone) === cle) || null;
}

// Tickets du jour relevant des équipes d'un chef donné.
// Un chef ne peut renseigner que ses propres interventions.
export async function ticketsDuJourPourChef(day, chef) {
  await ensureSchema();
  const sql = db();
  return sql`
    select t.ref, t.client, t.msan, t.delai::float8 as delai, d.assigned_tech, d.statut
    from ticket_days d
    join tickets t on t.ref = d.ref
    where d.day = ${day}::date
      and d.assigned_tech in (select name from techs where chef = ${chef})`;
}

// ── WhatsApp entrant ────────────────────────────────────────
// Enregistre un message reçu. Idempotent : Meta rejoue les webhooks non acquittés.
export async function saveInbound(m) {
  await ensureSchema();
  const sql = db();
  const rows = await sql`
    insert into wa_messages (wa_message_id, de, nom, type, texte, media_id, raw)
    values (${m.id || null}, ${m.from || ''}, ${m.name || ''}, ${m.type || ''},
            ${m.text || null}, ${m.mediaId || null}, ${JSON.stringify(m.raw || {})}::jsonb)
    on conflict (wa_message_id) do nothing
    returning id`;
  return { nouveau: rows.length > 0 };
}

export async function saveHit(h) {
  try {
    await ensureSchema();
    await db()`insert into wa_hits (signature, taille, resultat)
               values (${h.signature || 'absente'}, ${h.taille || 0}, ${h.resultat || ''})`;
  } catch { /* le diagnostic ne doit jamais casser la reception */ }
}

export async function listHits(limit = 20) {
  await ensureSchema();
  const sql = db();
  return sql`
    select signature, taille, resultat, to_char(recu_le, 'DD/MM HH24:MI:SS') as recu_le
    from wa_hits order by recu_le desc limit ${limit}`;
}

export async function saveStatus(s) {
  await ensureSchema();
  const sql = db();
  await sql`insert into wa_statuses (message_id, destinataire, statut, erreur_code, erreur_titre)
            values (${s.id || null}, ${s.recipient || ''}, ${s.status || ''},
                    ${s.errorCode || null}, ${s.errorTitle || null})`;
}

export async function listStatuses(limit = 20) {
  await ensureSchema();
  const sql = db();
  return sql`
    select destinataire, statut, erreur_code, erreur_titre,
           to_char(recu_le, 'DD/MM HH24:MI:SS') as recu_le
    from wa_statuses order by recu_le desc limit ${limit}`;
}

export async function listInbound(limit = 50) {
  await ensureSchema();
  const sql = db();
  return sql`
    select id, de, nom, type, texte, media_id, traite,
           to_char(recu_le, 'DD/MM HH24:MI') as recu_le
    from wa_messages order by recu_le desc limit ${limit}`;
}

// Historique : volumétrie jour par jour + tickets qui traînent
export async function getHistory(limit = 30) {
  await ensureSchema();
  const sql = db();
  const days = await sql`
    select d.day::text as day, count(*)::int as total,
           count(*) filter (where d.delai >= 2)::int as rouge,
           count(*) filter (where d.tranche = 'HD')::int as hd,
           (select count(*)::int from tickets t where t.closed_on = d.day) as clos
    from ticket_days d group by d.day order by d.day desc limit ${limit}`;
  const vieux = await sql`
    select ref, client, msan, days_seen, delai::float8 as delai, assigned_tech,
           first_seen::text as first_seen
    from tickets where status = 'ouvert' and days_seen > 1
    order by days_seen desc, delai desc limit 50`;
  const [tot] = await sql`
    select count(*)::int as total,
           count(*) filter (where status = 'ouvert')::int as ouverts,
           count(*) filter (where status = 'clos')::int as clos
    from tickets`;
  return { days, vieux, totaux: tot };
}
