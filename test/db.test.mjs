// Test de la couche base : exécute le vrai SQL sur un Postgres embarqué (PGlite).
// Lancer avec : npm run test:db
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {
  useSqlClient, getSettings, saveSettings, saveUpload, getDay, assignTickets, getHistory,
  setStatut, getAvancement, getEcarts, planifier,
} from '../lib/db.js';

// ── Shim : reproduit l'API tagged-template du driver Neon sur PGlite ──
function makeSql(pg) {
  const build = (strings, values) => {
    let text = '';
    const params = [];
    strings.forEach((s, i) => {
      text += s;
      if (i < values.length) {
        const v = values[i];
        if (v && v.__raw) text += v.sql;
        else { params.push(v); text += `$${params.length}`; }
      }
    });
    return { text, params };
  };
  const run = (q) => pg.query(q.text, q.params).then((r) => r.rows);
  const sql = (strings, ...values) => {
    const q = build(strings, values);
    return { ...q, then: (ok, ko) => run(q).then(ok, ko) };  // lazy comme Neon
  };
  sql.unsafe = (s) => ({ __raw: true, sql: s });
  sql.transaction = async (queries) => {
    await pg.exec('begin');
    try {
      const out = [];
      for (const q of queries) out.push(await run(q));
      await pg.exec('commit');
      return out;
    } catch (e) {
      await pg.exec('rollback');
      throw e;
    }
  };
  return sql;
}

const T = (ref, msan, delai, extra = {}) => ({
  ref, nd: '05221', client: `CLIENT ${ref}`, msan, msanKey: msan.toUpperCase(),
  enreg: '20/07 08:00', delai, famille: 'FTTH', contact: '0600', adresse: 'CASA',
  avancement: '', tranche: delai >= 2 ? 'HD' : 'DD', splitter: null, ...extra,
});

let pass = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }

const pg = new PGlite();
useSqlClient(makeSql(pg));

console.log('\n── Réglages ──');
const s0 = await getSettings();
assert.equal(s0.techs.length, 7, 'seed techniciens');
assert.equal(s0.zones.length, 14, 'seed zones');
assert.equal(s0.chefs.length, 1, 'seed chefs');
ok('schéma créé et réglages par défaut seedés');

const s1 = await saveSettings({
  chefs: [{ name: 'Soufiane', phone: '212600000001' }, { name: 'Issam', phone: '212600000002' }],
  techs: [
    { name: 'RACHID', phone: '212611111111', active: true, chef: 'Soufiane' },
    { name: 'RAFIK', phone: '212622222222', active: true, chef: 'Issam' },
    { name: 'HAMID', phone: '212633333333', active: true, chef: 'Issam' },
  ],
  zones: [
    { msan: 'MNOC-TAOUZAR', tech: 'RACHID' },
    { msan: 'GA-C-COLLINE-1', tech: 'RAFIK' },
    { msan: 'MZIC-Inara4-1', tech: 'HAMID' },
  ],
});
assert.equal(s1.techs.length, 3);
assert.equal(s1.zones.length, 3);
assert.equal(s1.chefs.length, 2);
assert.equal(s1.techs[0].chef, 'Soufiane', 'rattachement chef conservé');
ok('remplacement complet des réglages (techniciens / zones / chefs)');

console.log('\n── Jour 1 : premier dépôt ──');
const d1 = await saveUpload('2026-07-20', [
  T('R001', 'MNOC-TAOUZAR', 3.2),
  T('R002', 'GA-C-COLLINE-1', 1.4),
  T('R003', 'MSAN-INCONNU', 0.5),
  T('R004', 'MZIC-Inara4-1', 2.1, { avancement: 'SPLT TAOUZAR:1-1-14-8 ISOLE', splitter: 'TAOUZAR:1-1-14-8' }),
]);
assert.equal(d1.tickets.length, 4);
assert.equal(d1.assign.R001, 'RACHID', 'affectation par MSAN');
assert.equal(d1.assign.R002, 'RAFIK');
assert.equal(d1.assign.R003, null, 'MSAN inconnu → non affecté');
assert.equal(Object.keys(d1.reports).length, 0, 'aucun report au 1er jour');
assert.equal(d1.closed, 0);
assert.equal(d1.tickets.find((t) => t.ref === 'R004').splitter, 'TAOUZAR:1-1-14-8');
assert.equal(typeof d1.tickets[0].delai, 'number', 'délai renvoyé en nombre');
ok('4 tickets enregistrés et distribués par MSAN');

console.log('\n── Jour 2 : déduplication + clôture ──');
const d2 = await saveUpload('2026-07-21', [
  T('R001', 'MNOC-TAOUZAR', 4.2),
  T('R003', 'MSAN-INCONNU', 1.5),
  T('R005', 'GA-C-COLLINE-1', 0.3),
]);
assert.equal(d2.tickets.length, 3, 'seuls les tickets du jour sont renvoyés');
assert.equal(d2.reports.R001, 1, 'R001 déjà vu 1 jour avant');
assert.equal(d2.reports.R003, 1);
assert.equal(d2.reports.R005, undefined, 'nouveau ticket : pas de report');
assert.equal(d2.closed, 2, 'R002 et R004 disparus du fichier → traités');
assert.equal(d2.tickets.find((t) => t.ref === 'R001').days_seen, 2, 'compteur de jours');
assert.equal(d2.tickets.find((t) => t.ref === 'R001').delai, 4.2, 'délai mis à jour');
ok('déduplication par n° de ticket, compteur de jours, clôture des disparus');

console.log('\n── Réaffectation manuelle ──');
await assignTickets(['R003'], 'HAMID', '2026-07-21');
const after = await getDay('2026-07-21');
assert.equal(after.assign.R003, 'HAMID');
const d3 = await saveUpload('2026-07-22', [
  T('R001', 'MNOC-TAOUZAR', 5.2),
  T('R003', 'MSAN-INCONNU', 2.5),
]);
assert.equal(d3.assign.R003, 'HAMID', "l'affectation manuelle survit à l'upload suivant");
assert.equal(d3.assign.R001, 'RACHID', 'affectation automatique recalculée');
assert.equal(d3.reports.R001, 2, 'R001 vu 2 jours avant');
ok('réaffectation manuelle mémorisée et non écrasée');

console.log('\n── Technicien désactivé ──');
await saveSettings({
  chefs: [{ name: 'Soufiane', phone: '212600000001' }],
  techs: [
    { name: 'RACHID', phone: '212611111111', active: false, chef: 'Soufiane' },
    { name: 'RAFIK', phone: '212622222222', active: true, chef: 'Soufiane' },
  ],
  zones: [{ msan: 'MNOC-TAOUZAR', tech: 'RACHID' }, { msan: 'GA-C-COLLINE-1', tech: 'RAFIK' }],
});
const d4 = await saveUpload('2026-07-23', [T('R001', 'MNOC-TAOUZAR', 6.2), T('R009', 'GA-C-COLLINE-1', 0.2)]);
assert.equal(d4.assign.R001, null, 'technicien inactif → ticket non affecté');
assert.equal(d4.assign.R009, 'RAFIK');
ok('un technicien désactivé ne reçoit plus de tickets');

console.log('\n── Historique ──');
const h = await getHistory();
assert.equal(h.days.length, 4, '4 journées enregistrées');
assert.equal(h.days[0].day, '2026-07-23', 'tri du plus récent au plus ancien');
assert.equal(h.days[0].total, 2);
assert.equal(h.totaux.total, 6, 'R001..R005 + R009');
const r001 = h.vieux.find((t) => t.ref === 'R001');
assert.equal(r001.days_seen, 4, 'R001 présent 4 jours');
assert.ok(h.totaux.clos >= 2, 'tickets clos comptés');
ok('historique jour par jour + tickets qui traînent');

console.log('\n── Cas limites ──');
const dEmpty = await saveUpload('2026-07-24', []);
assert.equal(dEmpty.tickets.length, 0, 'fichier vide accepté');
assert.equal(dEmpty.closed, 2, 'les tickets de la veille sont clôturés');
const reOpen = await saveUpload('2026-07-25', [T('R001', 'MNOC-TAOUZAR', 8.0)]);
assert.equal(reOpen.tickets[0].status, 'ouvert', 'un ticket qui revient est rouvert');
ok('fichier vide et réouverture d\'un ticket clos');

console.log('\n── Statuts terrain ──');
await saveSettings({
  chefs: [{ name: 'Soufiane', phone: '212600000001' }],
  techs: [
    { name: 'RACHID', phone: '212611111111', active: true, chef: 'Soufiane' },
    { name: 'RAFIK', phone: '212622222222', active: true, chef: 'Soufiane' },
  ],
  zones: [{ msan: 'MNOC-TAOUZAR', tech: 'RACHID' }, { msan: 'GA-C-COLLINE-1', tech: 'RAFIK' }],
});
await saveUpload('2026-08-01', [
  T('R100', 'MNOC-TAOUZAR', 3.0), T('R200', 'MNOC-TAOUZAR', 2.5),
  T('R300', 'GA-C-COLLINE-1', 0.5),
]);
await setStatut(['R100'], 'fait', { day: '2026-08-01' });
await setStatut(['R200'], 'pas_acces', { day: '2026-08-01', motif: 'Client absent' });
const j = await getDay('2026-08-01');
assert.equal(j.statuts.R100.statut, 'fait');
assert.equal(j.statuts.R200.motif, 'Client absent');
assert.equal(j.statuts.R200.source, 'chef', 'source par défaut = saisie chef');
assert.ok(j.statuts.R100.at, 'horodatage renseigné');
assert.equal(j.statuts.R300, undefined, 'ticket sans statut = en attente');
ok('pose de statut avec motif, horodatage et source');

await setStatut(['R100'], null, { day: '2026-08-01' });
const j2 = await getDay('2026-08-01');
assert.equal(j2.statuts.R100, undefined, 'annulation remet en attente');
await setStatut(['R100'], 'fait', { day: '2026-08-01', source: 'whatsapp' });
const j3 = await getDay('2026-08-01');
assert.equal(j3.statuts.R100.source, 'whatsapp', 'remontée WhatsApp tracée distinctement');
await assert.rejects(() => setStatut(['R100'], 'nimporte_quoi', { day: '2026-08-01' }), /statut inconnu/);
ok('annulation, source whatsapp et rejet d\'un statut invalide');

const av = await getAvancement('2026-08-01');
const avRachid = av.find((a) => a.tech === 'RACHID');
assert.equal(avRachid.total, 2);
assert.equal(avRachid.fait, 1);
assert.equal(avRachid.pas_acces, 1);
assert.equal(avRachid.rouges_en_attente, 0, 'les 2 rouges de RACHID sont renseignés');
const avRafik = av.find((a) => a.tech === 'RAFIK');
assert.equal(avRafik.total, 1);
assert.equal(avRafik.fait, 0);
ok('avancement du jour par technicien');

// Le lendemain R100 est toujours dans le fichier alors qu'il a été déclaré fait
await saveUpload('2026-08-02', [T('R100', 'MNOC-TAOUZAR', 4.0), T('R300', 'GA-C-COLLINE-1', 1.5)]);
const ecarts = await getEcarts('2026-08-02');
assert.equal(ecarts.length, 1, 'un seul écart détecté');
assert.equal(ecarts[0].ref, 'R100', 'déclaré fait la veille mais toujours présent');
ok('écart déclaratif / fichier : intervention faite mais non clôturée côté IAM');


console.log('\n── Arbitrage du matin ──');
await saveSettings({
  chefs: [{ name: 'Soufiane', phone: '212600010013' }],
  techs: [{ name: 'RACHID', phone: '2126111', active: true, chef: 'Soufiane' },
          { name: 'RAFIK', phone: '2126222', active: true, chef: 'Soufiane' }],
  zones: [{ msan: 'MNOC-TAOUZAR', tech: 'RACHID' }, { msan: 'GA-C-COLLINE-1', tech: 'RAFIK' }],
});
await saveUpload('2026-09-01', [
  T('R500', 'MNOC-TAOUZAR', 2.0), T('R501', 'MNOC-TAOUZAR', 1.0), T('R502', 'GA-C-COLLINE-1', 0.5),
]);
await setStatut(['R500'], 'fait', { day: '2026-09-01', source: 'whatsapp' });
await setStatut(['R501'], 'pas_acces', { day: '2026-09-01', motif: 'Client absent', source: 'whatsapp' });

// Le lendemain les trois reviennent dans le fichier
const arbA = await saveUpload('2026-09-02', [
  T('R500', 'MNOC-TAOUZAR', 3.0), T('R501', 'MNOC-TAOUZAR', 2.0), T('R502', 'GA-C-COLLINE-1', 1.5),
]);
const arbRefs = Object.fromEntries(arbA.tickets.map((t) => [t.ref, t]));
assert.equal(arbRefs.R500.hors_dispatch, true, 'declare fait hier -> exclu du dispatch');
assert.equal(arbRefs.R501.hors_dispatch, true, 'motif hier -> exclu aussi');
assert.equal(arbRefs.R502.hors_dispatch, false, 'jamais renseigne -> dispatch normal');
assert.equal(arbRefs.R500.arbitrage, 'fait');
assert.equal(arbRefs.R501.arbitrage, 'pas_acces');
assert.equal(arbRefs.R501.arbitrage_motif, 'Client absent', 'le motif de la veille est repris');
assert.equal(arbRefs.R500.arbitrage_le, '2026-09-01', 'date du dernier renseignement');
assert.equal(arbRefs.R500.assigned_tech, 'RACHID', 'equipe suggeree conservee');
ok('tickets deja renseignes exclus du dispatch, avec statut, motif et date de la veille');

await planifier(['R500'], '2026-09-02', true);
const arbB = await getDay('2026-09-02');
assert.equal(arbB.tickets.find((t) => t.ref === 'R500').hors_dispatch, false, "l'orienteur l'a replanifie");
assert.equal(arbB.tickets.find((t) => t.ref === 'R501').hors_dispatch, true, 'les autres restent exclus');
ok('replanification a la main par l orienteur');

// Rechargement du fichier le jour meme : l'arbitrage doit se rejouer a l'identique
await setStatut(['R502'], 'fait', { day: '2026-09-02' });
const rechargement = await saveUpload('2026-09-02', [
  T('R500', 'MNOC-TAOUZAR', 3.0), T('R501', 'MNOC-TAOUZAR', 2.0), T('R502', 'GA-C-COLLINE-1', 1.5),
]);
const apres = Object.fromEntries(rechargement.tickets.map((t) => [t.ref, t]));
assert.equal(apres.R502.hors_dispatch, true, 'renseigne aujourd hui -> exclu des le rechargement');
assert.equal(apres.R502.arbitrage, 'fait');
assert.equal(apres.R500.hors_dispatch, false, "la decision de l'orienteur survit au rechargement");
assert.equal(apres.R501.hors_dispatch, true, 'non arbitre -> toujours exclu');
ok('un rechargement en cours de journee produit le meme arbitrage, sans effacer les decisions');

// Le surlendemain : R501 revient avec le motif le plus recent
await setStatut(['R501'], 'reporte', { day: '2026-09-02', motif: 'POC a changer' });
const arbD = await saveUpload('2026-09-03', [T('R501', 'MNOC-TAOUZAR', 3.0)]);
const arbR501 = arbD.tickets.find((t) => t.ref === 'R501');
assert.equal(arbR501.arbitrage, 'reporte');
assert.equal(arbR501.arbitrage_motif, 'POC a changer', 'c est le dernier motif qui compte, pas le premier');
assert.equal(arbR501.days_seen, 3);
ok('c est toujours le dernier statut connu qui est repris');

await pg.close();
console.log(`
✅ ${pass} groupes de vérifications passés — la couche base est saine.
`);
