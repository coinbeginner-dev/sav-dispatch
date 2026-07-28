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
    select ref, nd, client, msan, msan_key, enreg, delai::float8 as delai, famille,
           contact, adresse, avancement, tranche, splitter, days_seen, status,
           assigned_tech, assign_manual, first_seen::text as first_seen
    from tickets
    where ref in (select ref from ticket_days where day = ${day}::date)
    order by delai desc, ref`;
  const reps = await sql`
    select d.ref, count(*)::int as n from ticket_days d
    where d.day < ${day}::date
      and d.ref in (select ref from ticket_days where day = ${day}::date)
    group by d.ref`;

  const assign = {};
  const reports = {};
  for (const t of tickets) assign[t.ref] = t.assigned_tech || null;
  for (const r of reps) reports[r.ref] = r.n;
  return { day, tickets, assign, reports };
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
