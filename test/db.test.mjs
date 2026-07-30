// Test de la couche base : exécute le vrai SQL sur un Postgres embarqué (PGlite).
// Lancer avec : npm run test:db
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {
  useSqlClient, getSettings, saveSettings, saveUpload, getDay, assignTickets, getHistory,
  setStatut, getAvancement, getEcarts, planifier, arbitrer, getHistoriqueTickets,
} from '../lib/db.js';
import { DEFAULT_TECHS, DEFAULT_ZONES, DEFAULT_CHEFS } from '../lib/dispatch.js';

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
assert.equal(s0.techs.length, DEFAULT_TECHS.length, 'seed equipes');
assert.equal(s0.zones.length, DEFAULT_ZONES.length, 'seed zones');
assert.equal(s0.chefs.length, DEFAULT_CHEFS.length, 'seed chefs');
assert.ok(s0.techs.every((t) => 'compte' in t), 'le compte IAM est expose');
assert.ok(s0.techs.some((t) => t.compte), 'au moins une equipe a un compte IAM');
ok('schéma créé et réglages par défaut seedés, compte IAM inclus');

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
  T('R503', 'MNOC-TAOUZAR', 1.0),
]);
await setStatut(['R500'], 'blocage', { day: '2026-09-01', motif: 'Autre', texte: 'Câble sectionné', source: 'whatsapp' });
await setStatut(['R501'], 'pas_acces', { day: '2026-09-01', motif: 'Client absent', source: 'whatsapp' });
await setStatut(['R503'], 'fait', { day: '2026-09-01', source: 'whatsapp' });

// Le lendemain les quatre reviennent dans le fichier
const arbA = await saveUpload('2026-09-02', [
  T('R500', 'MNOC-TAOUZAR', 3.0), T('R501', 'MNOC-TAOUZAR', 2.0), T('R502', 'GA-C-COLLINE-1', 1.5),
  T('R503', 'MNOC-TAOUZAR', 2.0),
]);
const arbRefs = Object.fromEntries(arbA.tickets.map((t) => [t.ref, t]));
assert.equal(arbRefs.R500.hors_dispatch, true, 'declare blocage hier -> exclu du dispatch, en attente d arbitrage');
assert.equal(arbRefs.R500.arbitrage_decide, false, 'encore en cours -> attend une decision');
assert.equal(arbRefs.R501.hors_dispatch, true, 'motif hier -> exclu aussi');
assert.equal(arbRefs.R502.hors_dispatch, false, 'jamais renseigne -> dispatch normal');
assert.equal(arbRefs.R500.arbitrage, 'blocage');
assert.equal(arbRefs.R500.arbitrage_motif, 'Autre');
assert.equal(arbRefs.R500.arbitrage_texte, 'Câble sectionné', 'le texte libre suit aussi, pas seulement le motif');
assert.equal(arbRefs.R501.arbitrage, 'pas_acces');
assert.equal(arbRefs.R501.arbitrage_motif, 'Client absent', 'le motif de la veille est repris');
assert.equal(arbRefs.R500.arbitrage_le, '2026-09-01', 'date du dernier renseignement');
assert.equal(arbRefs.R500.assigned_tech, 'RACHID', 'equipe suggeree conservee');
ok('tickets encore en cours (blocage/pas acces) exclus du dispatch, avec statut, motif, texte et date de la veille');

assert.equal(arbRefs.R503.hors_dispatch, true, 'declare fait hier -> cloture automatiquement');
assert.equal(arbRefs.R503.arbitrage_decide, true, 'fait -> aucune decision a prendre, cloture directe');
assert.equal(arbRefs.R503.statut, 'fait', 'le statut du jour reprend directement fait');
assert.equal(arbRefs.R503.source, 'orienteur');
ok('un ticket deja declare fait se cloture tout seul, sans passer par la liste a arbitrer');

await planifier(['R500'], '2026-09-02', true);
const arbB = await getDay('2026-09-02');
const r500b = arbB.tickets.find((t) => t.ref === 'R500');
assert.equal(r500b.hors_dispatch, false, "l'orienteur l'a replanifie");
assert.equal(r500b.statut, 'blocage', 'le dernier statut connu est repris au lieu de repartir a blanc');
assert.equal(r500b.motif, 'Autre');
assert.equal(r500b.texte, 'Câble sectionné', 'le texte libre suit jusque dans le message au technicien');
assert.equal(arbB.tickets.find((t) => t.ref === 'R501').hors_dispatch, true, 'les autres restent exclus');
const histR500 = await getHistoriqueTickets(['R500']);
assert.equal(histR500.R500[0].statut, 'blocage');
assert.equal(histR500.R500[0].source, 'orienteur');
ok('replanification a la main par l orienteur : le dernier statut/motif/texte connu est conserve et trace');

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


console.log('\n── Clôture depuis l\'arbitrage ──');
await saveUpload('2026-09-04', [T('R600', 'MNOC-TAOUZAR', 1.0), T('R601', 'MNOC-TAOUZAR', 1.0)]);
await setStatut(['R600'], 'reporte', { day: '2026-09-04', motif: 'POC a changer' });
await setStatut(['R601'], 'planifie', { day: '2026-09-04' });
const arbJ = await saveUpload('2026-09-05', [T('R600', 'MNOC-TAOUZAR', 2.0), T('R601', 'MNOC-TAOUZAR', 2.0)]);
assert.equal(arbJ.tickets.filter((t) => t.hors_dispatch && !t.arbitrage_decide).length, 2, 'les 2 sont encore en cours -> arrivent en arbitrage');

await arbitrer(['R600'], '2026-09-05', 'cloturer');
const apresClot = await getDay('2026-09-05');
const r600 = apresClot.tickets.find((t) => t.ref === 'R600');
assert.equal(r600.hors_dispatch, true, 'cloture : reste hors du dispatch');
assert.equal(r600.arbitrage_decide, true, "cloture : sort de la liste d'arbitrage");
assert.equal(apresClot.statuts.R600.statut, 'fait', 'cloture : acte comme traite');
assert.equal(apresClot.statuts.R600.source, 'orienteur', 'la decision est tracee comme venant de l orienteur');
assert.equal(apresClot.statuts.R600.motif, 'POC a changer', 'le motif d origine est conserve');
const restants = apresClot.tickets.filter((t) => t.hors_dispatch && !t.arbitrage_decide);
assert.equal(restants.length, 1, 'seul R601 reste a arbitrer');
assert.equal(restants[0].ref, 'R601');
ok('cloture depuis l arbitrage : hors dispatch, acte traite, sorti de la liste');

await arbitrer(['R601'], '2026-09-05', 'planifier');
const apresPlan = await getDay('2026-09-05');
const r601 = apresPlan.tickets.find((t) => t.ref === 'R601');
assert.equal(r601.hors_dispatch, false, 'planifie : revient en dispatch');
assert.equal(r601.statut, 'planifie', 'le dernier statut connu (planifie) est repris, pas remis a blanc');
assert.equal(apresPlan.tickets.filter((t) => t.hors_dispatch && !t.arbitrage_decide).length, 0, 'liste d arbitrage videe');
const rechargeApres = await saveUpload('2026-09-05', [T('R600', 'MNOC-TAOUZAR', 2.0), T('R601', 'MNOC-TAOUZAR', 2.0)]);
assert.equal(rechargeApres.tickets.filter((t) => t.hors_dispatch && !t.arbitrage_decide).length, 0,
  'un rechargement ne fait pas revenir ce qui a ete arbitre');
ok('les deux decisions vident la liste et survivent au rechargement');

console.log('\n── Nouveau vocabulaire (fait / planifie / blocage) + historique ──');
await saveUpload('2026-10-01', [T('R700', 'MNOC-TAOUZAR', 1.5)]);
await setStatut(['R700'], 'blocage', { day: '2026-10-01', motif: 'GC' });
let j700 = await getDay('2026-10-01');
assert.equal(j700.statuts.R700.statut, 'blocage');
assert.equal(j700.statuts.R700.motif, 'GC');
ok('statut blocage avec motif GC');

await setStatut(['R700'], 'blocage', { day: '2026-10-01', motif: 'Autre', texte: 'Câble arraché par un tiers' });
j700 = await getDay('2026-10-01');
assert.equal(j700.statuts.R700.motif, 'Autre');
assert.equal(j700.statuts.R700.texte, 'Câble arraché par un tiers', 'le texte libre est conserve sur ticket_days');
ok('blocage "Autre" avec texte libre enregistre');

await setStatut(['R700'], 'planifie', { day: '2026-10-01' });
j700 = await getDay('2026-10-01');
assert.equal(j700.statuts.R700.statut, 'planifie');
ok('statut planifie');

await setStatut(['R700'], 'fait', { day: '2026-10-01' });
const hist = await getHistoriqueTickets(['R700']);
assert.equal(hist.R700.length, 4, 'les 4 saisies sont conservees, rien n ecrase l historique');
assert.equal(hist.R700[0].statut, 'fait', 'la plus recente en tete');
assert.equal(hist.R700[3].statut, 'blocage', 'la plus ancienne en dernier');
assert.equal(hist.R700[2].texte, 'Câble arraché par un tiers');
ok('historique ligne par ligne : rien n est ecrase malgre 4 changements de statut sur le meme ticket');

const j700bis = await getDay('2026-10-01');
assert.equal(Object.keys(j700bis.historique).length, 1, 'getDay expose l historique du ticket concerne');
assert.equal(j700bis.historique.R700.length, 4);
ok('l historique est aussi expose directement par getDay');

await pg.close();
console.log(`\n✅ ${pass} groupes de vérifications passés — la couche base est saine.\n`);
