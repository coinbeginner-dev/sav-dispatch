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
  // Compte IAM de l'equipe (identifiant technicien cote operateur)
  await sql`alter table techs add column if not exists compte text not null default ''`;
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

  // Date du dernier envoi WhatsApp effectif (clic sur "Envoyer" dans la
  // fenêtre de sélection) — pas une confirmation de livraison, juste la trace
  // que ce ticket faisait partie d'un message ouvert dans WhatsApp.
  await sql`alter table tickets add column if not exists envoye_le timestamptz`;

  // Contact corrigé à la main (ex : IAM donne un nouveau numéro après un
  // blocage "injoignable"). Comme assign_manual, ça doit résister au prochain
  // import du fichier, sinon le numéro corrigé se ferait écraser par
  // l'ancien numéro erroné toujours présent côté IAM.
  await sql`alter table tickets add column if not exists contact_manual boolean not null default false`;

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
  // Texte libre saisi avec un blocage « Autre » : affiché sur la carte du jour,
  // et conservé ligne à ligne dans ticket_notes pour l'historique.
  await sql`alter table ticket_days add column if not exists texte     text`;

  // Arbitrage du matin : un ticket deja renseigne un jour precedent revient
  // dans le fichier. Il est exclu du dispatch par defaut — envoyer une equipe
  // sur une intervention deja faite coute une demi-journee — et l'orienteur
  // decide de le replanifier ou non.
  await sql`alter table ticket_days add column if not exists hors_dispatch  boolean not null default false`;
  await sql`alter table ticket_days add column if not exists arbitrage      text`;
  await sql`alter table ticket_days add column if not exists arbitrage_motif text`;
  // Texte libre ("Autre") du dernier statut connu, conservé à part du motif
  // pour que la replanification puisse le réafficher au technicien tel quel.
  await sql`alter table ticket_days add column if not exists arbitrage_texte text`;
  await sql`alter table ticket_days add column if not exists arbitrage_le   date`;
  // Arbitrage tranché par l'orienteur : sa décision survit aux rechargements
  // du fichier, comme une réaffectation manuelle.
  await sql`alter table ticket_days add column if not exists arbitrage_decide boolean not null default false`;

  // Historique des retours terrain, ligne par ligne et horodatée.
  // ticket_days ne garde que le dernier état du jour ; ici rien n'est écrasé,
  // ce qui permet de retracer la vie complète d'un ticket sur plusieurs jours.
  await sql`create table if not exists ticket_notes (
    id       bigserial primary key,
    ref      text not null,
    day      date not null,
    statut   text,
    motif    text,
    texte    text,
    source   text,
    cree_le  timestamptz not null default now()
  )`;
  await sql`create index if not exists ticket_notes_ref_idx on ticket_notes (ref, cree_le desc)`;

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
  await sql`insert into techs (name, phone, active, chef, ord, compte)
    select * from unnest(
      ${DEFAULT_TECHS.map((t) => t.name)}::text[],
      ${DEFAULT_TECHS.map((t) => t.phone || '')}::text[],
      ${DEFAULT_TECHS.map((t) => t.active !== false)}::boolean[],
      ${DEFAULT_TECHS.map((t) => t.chef || '')}::text[],
      ${DEFAULT_TECHS.map((_, i) => i)}::int[],
      ${DEFAULT_TECHS.map((t) => t.compte || '')}::text[]
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
    sql`select name, phone, active, chef, compte from techs order by ord, name`,
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
    sql`insert into techs (name, phone, active, chef, ord, compte) select * from unnest(
      ${cTechs.map((t) => t.name.trim())}::text[],
      ${cTechs.map((t) => t.phone || '')}::text[],
      ${cTechs.map((t) => t.active !== false)}::boolean[],
      ${cTechs.map((t) => t.chef || '')}::text[],
      ${cTechs.map((_, i) => i)}::int[],
      ${cTechs.map((t) => t.compte || '')}::text[]
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
// incrément du compteur de jours. `clore` (défaut false) : ne clôture les
// tickets ouverts absents du fichier QUE si explicitement demandé — un
// fichier plus petit (juste les nouveaux tickets du jour, ou tout autre
// extrait partiel) n'efface donc jamais ce qui reste en cours ailleurs,
// avec leur équipe, leur historique et leurs corrections (contact...) intacts.
export async function saveUpload(day, tickets, { clore = false } = {}) {
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
        famille = excluded.famille,
        contact = case when tickets.contact_manual then tickets.contact else excluded.contact end,
        adresse = excluded.adresse,
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

    // Regroupement splitter : tous les tickets d'un meme splitter doivent
    // avoir la meme equipe assignee. Sans ca, le tableau de bord les
    // repartit sur des colonnes differentes (fusion par equipe cote client)
    // et l'equipe visite le meme splitter plusieurs fois sans le savoir.
    // Une affectation manuelle deja presente dans le groupe prime ; sinon on
    // aligne tout le monde sur l'equipe deja affectee dans le groupe.
    await sql`
      with groupes as (
        select splitter,
               (array_agg(assigned_tech order by assign_manual desc, ref)
                 filter (where assigned_tech is not null))[1] as tech,
               bool_or(assign_manual) as manuel
        from tickets
        where splitter is not null and status = 'ouvert'
        group by splitter
        having count(*) > 1
      )
      update tickets t set assigned_tech = g.tech, assign_manual = g.manuel
      from groupes g
      where t.splitter = g.splitter and t.status = 'ouvert'
        and (t.assigned_tech is distinct from g.tech or t.assign_manual is distinct from g.manuel)`;

    // L'affectation du jour doit refleter celle du ticket, y compris quand
    // elle a ete posee a la main un autre jour. Sans cette remise a niveau,
    // le tableau de bord et le ciblage WhatsApp des chefs divergent.
    await sql`
      update ticket_days d set assigned_tech = t.assigned_tech
      from tickets t
      where t.ref = d.ref and d.day = ${day}::date
        and d.assigned_tech is distinct from t.assigned_tech`;
  }

  // Arbitrage : tout ticket qui a DEJA un statut, quel que soit le jour ou il
  // a ete pose, sort du dispatch. Ce qui compte c'est qu'il soit renseigne,
  // pas la date : recharger le fichier en cours de journee doit produire le
  // meme arbitrage que le chargement du lendemain.
  // Une decision deja prise par l'orienteur n'est jamais rejouee.
  //
  // Cas "fait"/"clos" : deja acte comme termine un jour precedent (vraiment
  // fait, ou cloture avec motif par l'orienteur) -> reconduction automatique,
  // sans repasser par la liste a arbitrer (reservee aux cas encore en cours).
  // Le statut exact (fait ou clos) est repris tel quel, pas ecrase par "fait".
  // Cas "planifie"/"blocage" (ou anciennes valeurs) : toujours en cours ->
  // reste a arbitrer, avec le dernier statut/motif/texte connus affiches pour
  // que l'orienteur decide en connaissance de cause au lieu de redistribuer
  // a l'aveugle.
  if (t.length) {
    const maintenant = new Date().toISOString();
    const clotures = await sql`
      with dernier as (
        select distinct on (ref) ref, statut, motif, texte, day
        from ticket_days
        where statut is not null
        order by ref, day desc
      )
      update ticket_days d set
        hors_dispatch = true,
        arbitrage_decide = true,
        arbitrage = dernier.statut,
        arbitrage_motif = dernier.motif,
        arbitrage_texte = dernier.texte,
        arbitrage_le = dernier.day,
        statut = dernier.statut,
        motif = dernier.motif,
        texte = dernier.texte,
        source = 'orienteur',
        statut_at = ${maintenant}::timestamptz
      from dernier
      where d.day = ${day}::date and d.ref = dernier.ref and not d.arbitrage_decide
        and dernier.statut in ('fait', 'clos')
      returning d.ref, d.statut, d.motif, d.texte`;

    if (clotures.length) {
      await sql`
        insert into ticket_notes (ref, day, statut, motif, texte, source)
        select u.ref, ${day}::date, u.statut, nullif(u.motif, ''), nullif(u.texte, ''), 'orienteur'
        from unnest(
          ${clotures.map((c) => c.ref)}::text[],
          ${clotures.map((c) => c.statut)}::text[],
          ${clotures.map((c) => c.motif || '')}::text[],
          ${clotures.map((c) => c.texte || '')}::text[]
        ) as u(ref, statut, motif, texte)`;
    }

    await sql`
      with dernier as (
        select distinct on (ref) ref, statut, motif, texte, day
        from ticket_days
        where statut is not null
        order by ref, day desc
      )
      update ticket_days d set
        hors_dispatch = true,
        arbitrage = dernier.statut,
        arbitrage_motif = dernier.motif,
        arbitrage_texte = dernier.texte,
        arbitrage_le = dernier.day
      from dernier
      where d.day = ${day}::date and d.ref = dernier.ref and not d.arbitrage_decide
        and dernier.statut not in ('fait', 'clos')`;
  }

  // Tickets ouverts absents du fichier du jour → considérés traités, mais
  // uniquement si ce fichier est explicitement déclaré comme la liste
  // complète du reste à faire (clore = true). Par défaut, un ticket absent
  // reste ouvert : il n'a peut-être simplement pas été inclus dans cet envoi.
  const closed = clore ? await sql`
    update tickets set status = 'clos', closed_on = ${day}::date
    where status = 'ouvert' and last_seen < ${day}::date
    returning ref` : [];

  // Sans clôture : un ticket ouvert absent du fichier n'a pas de ligne
  // ticket_days pour aujourd'hui (getDay fait un join sur le jour) et
  // disparaîtrait donc du dispatch actif malgré tout. On reconduit sa
  // dernière ligne connue telle quelle (équipe, statut, arbitrage...) pour
  // qu'il continue d'apparaître exactement comme si le fichier l'avait
  // mentionné sans rien changer. Un ticket déjà acté fait/clos ne revient
  // pas : il est réellement terminé, pas juste absent de cet extrait.
  if (!clore) {
    await sql`
      with dernier as (
        select distinct on (ref) ref, statut, motif, texte, source, statut_at,
               hors_dispatch, arbitrage, arbitrage_motif, arbitrage_texte, arbitrage_le,
               arbitrage_decide
        from ticket_days
        order by ref, day desc
      )
      insert into ticket_days (ref, day, delai, assigned_tech, tranche, statut, motif, texte,
                                source, statut_at, hors_dispatch, arbitrage, arbitrage_motif,
                                arbitrage_texte, arbitrage_le, arbitrage_decide)
      select t.ref, ${day}::date, t.delai, t.assigned_tech, t.tranche,
             d.statut, d.motif, d.texte, d.source, d.statut_at,
             coalesce(d.hors_dispatch, false), d.arbitrage, d.arbitrage_motif, d.arbitrage_texte,
             d.arbitrage_le, coalesce(d.arbitrage_decide, false)
      from tickets t
      left join dernier d on d.ref = t.ref
      where t.status = 'ouvert' and t.last_seen < ${day}::date
        and (d.statut is null or d.statut not in ('fait', 'clos'))
      on conflict (ref, day) do nothing`;
  }

  const rows = await getDay(day);
  return { ...rows, closed: closed.length };
}

// Dernier jour pour lequel un fichier a été chargé. Sert de repli quand
// aucun fichier n'a encore été déposé aujourd'hui : plutôt qu'un écran vide,
// l'orienteur voit ce qui restait en cours la veille.
export async function getDernierJourAvecTickets() {
  await ensureSchema();
  const sql = db();
  const rows = await sql`select max(day)::text as jour from ticket_days`;
  return rows[0]?.jour || null;
}

// Tickets du jour + affectations + compteur de reports (jours antérieurs vus)
export async function getDay(day) {
  await ensureSchema();
  const sql = db();
  const tickets = await sql`
    select t.ref, t.nd, t.client, t.msan, t.msan_key, t.enreg, t.delai::float8 as delai,
           t.famille, t.contact, t.contact_manual, t.adresse, t.avancement, t.tranche, t.splitter,
           t.days_seen, t.status, t.assigned_tech, t.assign_manual, t.envoye_le,
           t.first_seen::text as first_seen,
           d.statut, d.motif, d.texte, d.source, d.statut_at,
           d.hors_dispatch, d.arbitrage, d.arbitrage_motif, d.arbitrage_texte,
           d.arbitrage_le::text as arbitrage_le, d.arbitrage_decide
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
    if (t.statut) statuts[t.ref] = { statut: t.statut, motif: t.motif, texte: t.texte, source: t.source, at: t.statut_at };
  }
  for (const r of reps) reports[r.ref] = r.n;
  // Historique par ticket : seuls ceux qui ont déjà un retour en portent un.
  const notes = await sql`
    select ref, day::text as jour, statut, motif, texte, source,
           to_char(cree_le, 'DD/MM HH24:MI') as le
    from ticket_notes
    where ref in (select ref from ticket_days where day = ${day}::date)
    order by cree_le desc`;
  const historique = {};
  for (const n of notes) (historique[n.ref] = historique[n.ref] || []).push(n);
  return { day, tickets, assign, reports, statuts, historique };
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

// Corrige le numéro de contact à la main (ex : IAM donne un nouveau numéro
// après un blocage "injoignable"). Mémorisé (contact_manual) pour que le
// prochain import du fichier ne réécrase pas la correction avec l'ancien
// numéro toujours présent côté IAM.
export async function updateContact(refs, contact) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  const rows = await sql`
    update tickets set contact = ${contact || ''}, contact_manual = true
    where ref = any(${list}::text[])
    returning ref`;
  return { ok: true, updated: rows.length };
}

// Marque des tickets comme envoyés (clic sur "Envoyer" dans la fenêtre de
// sélection WhatsApp) — pas une confirmation de livraison, juste la date à
// laquelle ce ticket faisait partie d'un message ouvert dans WhatsApp.
export async function marquerEnvoye(refs) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  const rows = await sql`
    update tickets set envoye_le = now()
    where ref = any(${list}::text[])
    returning ref`;
  return { ok: true, updated: rows.length };
}

// Statuts terrain. null / absent = en attente.
export const STATUTS = ['fait', 'planifie', 'blocage', 'clos'];
// Anciennes valeurs encore présentes en base : acceptées en lecture et en
// écriture pour ne pas invalider l'historique déjà constitué.
const STATUTS_ANCIENS = ['pas_acces', 'reporte'];

// Marque le statut d'un ou plusieurs tickets pour une journée, et ajoute une
// ligne d'historique horodatée par ticket — c'est elle qui permet de retracer
// ce qui s'est passé jour après jour, là où ticket_days est écrasé.
// `source` trace qui l'a saisi : 'chef', 'whatsapp', 'orienteur' ou 'fichier'.
export async function setStatut(refs, statut, { day, motif = null, texte = null, source = 'chef' } = {}) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  if (statut && ![...STATUTS, ...STATUTS_ANCIENS].includes(statut)) {
    throw new Error(`statut inconnu : ${statut}`);
  }

  const at = statut ? new Date().toISOString() : null;
  const rows = await sql`
    update ticket_days set
      statut = ${statut || null},
      motif = ${statut ? motif : null},
      texte = ${statut ? texte : null},
      source = ${statut ? source : null},
      statut_at = ${at}::timestamptz
    where day = ${day}::date and ref = any(${list}::text[])
    returning ref`;

  // Une annulation (statut null) n'ajoute pas de ligne : on ne garde que
  // les faits déclarés, pas les hésitations de saisie.
  if (statut && rows.length) {
    await sql`
      insert into ticket_notes (ref, day, statut, motif, texte, source)
      select u.ref, ${day}::date, ${statut}, ${motif}, ${texte}, ${source}
      from unnest(${rows.map((r) => r.ref)}::text[]) as u(ref)`;
  }
  return { ok: true, updated: rows.length };
}

// Historique complet d'un ou plusieurs tickets, du plus récent au plus ancien.
export async function getHistoriqueTickets(refs) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return {};
  const rows = await sql`
    select ref, day::text as jour, statut, motif, texte, source,
           to_char(cree_le, 'DD/MM HH24:MI') as le
    from ticket_notes where ref = any(${list}::text[])
    order by cree_le desc`;
  const parRef = {};
  for (const r of rows) (parRef[r.ref] = parRef[r.ref] || []).push(r);
  return parRef;
}

// Recherche dans TOUT l'historique de la base (pas seulement le jour
// affiché) : par n° de ticket ou nom de client. Sert à retrouver un ticket
// déjà clôturé il y a plusieurs jours — par exemple quand IAM le renvoie
// pour correction alors qu'on l'avait déjà marqué traité.
export async function rechercheGlobale(terme) {
  await ensureSchema();
  const sql = db();
  const t = String(terme || '').trim().toLowerCase();
  if (!t) return [];
  const like = `%${t}%`;
  const rows = await sql`
    select ref, client, msan, contact, contact_manual, assigned_tech, status,
           first_seen::text as first_seen, last_seen::text as last_seen, days_seen
    from tickets
    where lower(ref) like ${like} or lower(client) like ${like}
    order by last_seen desc
    limit 50`;
  if (!rows.length) return [];
  const refs = rows.map((r) => r.ref);
  const [historique, dernierStatut] = await Promise.all([
    getHistoriqueTickets(refs),
    sql`
      select distinct on (ref) ref, statut, motif, texte, day::text as day
      from ticket_days
      where ref = any(${refs}::text[]) and statut is not null
      order by ref, day desc`,
  ]);
  const statutParRef = Object.fromEntries(dernierStatut.map((d) => [d.ref, d]));
  return rows.map((r) => ({
    ...r,
    dernierStatut: statutParRef[r.ref] || null,
    historique: historique[r.ref] || [],
  }));
}

// Tous les tickets jamais suivis dans la base — pas seulement ceux du
// dispatch actif du jour. Sert à l'export "toute la base" : contrairement à
// l'export du jour (limité à ce qui apparaît dans getDay), celui-ci couvre
// aussi les tickets absents du fichier d'aujourd'hui (clore=false) et les
// tickets réellement clôturés, avec leur dernier statut et leur historique.
export async function listerTousLesTickets() {
  await ensureSchema();
  const sql = db();
  const rows = await sql`
    select ref, client, msan, contact, contact_manual, assigned_tech, status,
           delai::float8 as delai, tranche, splitter, envoye_le,
           first_seen::text as first_seen, last_seen::text as last_seen, days_seen,
           closed_on::text as closed_on
    from tickets
    order by last_seen desc, ref`;
  if (!rows.length) return [];
  const refs = rows.map((r) => r.ref);
  const [historique, dernierStatut] = await Promise.all([
    getHistoriqueTickets(refs),
    sql`
      select distinct on (ref) ref, statut, motif, texte, day::text as day
      from ticket_days
      where ref = any(${refs}::text[]) and statut is not null
      order by ref, day desc`,
  ]);
  const statutParRef = Object.fromEntries(dernierStatut.map((d) => [d.ref, d]));
  return rows.map((r) => ({
    ...r,
    dernierStatut: statutParRef[r.ref] || null,
    historique: historique[r.ref] || [],
  }));
}

// Réouvre un ticket déjà clôturé (fait/clos/absent des fichiers récents) :
// remet le ticket "ouvert" au niveau global et lui redonne une ligne active
// et vierge pour le jour affiché, pour qu'il réapparaisse dans le dispatch
// normal — sans attendre qu'un futur fichier le fasse réapparaître tout seul
// (ce qui le referait passer par l'arbitrage avec l'ancien statut, comme si
// de rien n'était).
export async function rouvrirTicket(refs, day) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };

  await sql`update tickets set status = 'ouvert', closed_on = null where ref = any(${list}::text[])`;
  const infos = await sql`select ref, delai, assigned_tech, tranche from tickets where ref = any(${list}::text[])`;
  for (const t of infos) {
    await sql`
      insert into ticket_days (ref, day, delai, assigned_tech, tranche)
      values (${t.ref}, ${day}::date, ${t.delai}, ${t.assigned_tech}, ${t.tranche})
      on conflict (ref, day) do update set
        statut = null, motif = null, texte = null, source = null, statut_at = null,
        hors_dispatch = false, arbitrage_decide = true,
        arbitrage = null, arbitrage_motif = null, arbitrage_texte = null, arbitrage_le = null`;
  }
  await sql`
    insert into ticket_notes (ref, day, statut, motif, texte, source)
    select u.ref, ${day}::date, 'reouvert', null, null, 'orienteur'
    from unnest(${list}::text[]) as u(ref)`;
  return { ok: true, updated: list.length };
}

// Arbitrage tranché par l'orienteur.
//   'planifier' → le ticket repart en dispatch chez son équipe.
//   'cloturer'  → il n'ira chez personne : acté "clos" avec un motif fourni
//                 par l'orienteur (distinct d'un "fait" réellement constaté
//                 sur le terrain), et quitte la liste d'arbitrage.
// Dans les deux cas la décision est mémorisée et survit aux rechargements.
export async function arbitrer(refs, day, decision = 'planifier', motif = null) {
  await ensureSchema();
  const sql = db();
  const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!list.length) return { ok: true, updated: 0 };
  const maintenant = new Date().toISOString();

  if (decision === 'cloturer') {
    const motifFourni = motif || null;
    const rows = await sql`
      update ticket_days set
        hors_dispatch = true,
        arbitrage_decide = true,
        statut = 'clos',
        motif = coalesce(nullif(${motifFourni}, ''), nullif(motif, ''), nullif(arbitrage_motif, ''), 'Clos sans motif précisé'),
        texte = null,
        source = 'orienteur',
        statut_at = ${maintenant}::timestamptz
      where day = ${day}::date and ref = any(${list}::text[])
      returning ref, motif, texte`;
    if (rows.length) {
      await sql`
        insert into ticket_notes (ref, day, statut, motif, texte, source)
        select u.ref, ${day}::date, 'clos', nullif(u.motif, ''), nullif(u.texte, ''), 'orienteur'
        from unnest(
          ${rows.map((r) => r.ref)}::text[],
          ${rows.map((r) => r.motif || '')}::text[],
          ${rows.map((r) => r.texte || '')}::text[]
        ) as u(ref, motif, texte)`;
    }
    return { ok: true, updated: rows.length };
  }

  // 'planifier' : le ticket repart en dispatch actif avec son dernier statut/
  // motif/texte connus deja affiches (au lieu de repartir a blanc), pour que
  // la carte du technicien et le message WhatsApp gardent le contexte de ce
  // qui avait deja ete constate (ex : "Blocage · Numéro injoignable").
  const rows = await sql`
    update ticket_days set
      hors_dispatch = false,
      arbitrage_decide = true,
      statut = arbitrage,
      motif = arbitrage_motif,
      texte = arbitrage_texte,
      source = 'orienteur',
      statut_at = ${maintenant}::timestamptz
    where day = ${day}::date and ref = any(${list}::text[])
    returning ref, statut, motif, texte`;
  const avecStatut = rows.filter((r) => r.statut);
  if (avecStatut.length) {
    await sql`
      insert into ticket_notes (ref, day, statut, motif, texte, source)
      select u.ref, ${day}::date, u.statut, nullif(u.motif, ''), nullif(u.texte, ''), 'orienteur'
      from unnest(
        ${avecStatut.map((r) => r.ref)}::text[],
        ${avecStatut.map((r) => r.statut)}::text[],
        ${avecStatut.map((r) => r.motif || '')}::text[],
        ${avecStatut.map((r) => r.texte || '')}::text[]
      ) as u(ref, statut, motif, texte)`;
  }
  return { ok: true, updated: rows.length };
}

// Compatibilité : ancienne signature booléenne
export function planifier(refs, day, dedans = true) {
  return arbitrer(refs, day, dedans ? 'planifier' : 'cloturer');
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
