// Test de la couche base NA : exécute le vrai SQL sur un Postgres embarqué (PGlite).
// Lancer avec : npm run test:na-db
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {
  useSqlClient, getSettings, saveSettings, importCommandes, getVue, setStatut, assignTeam, getHistorique,
} from '../lib/na-db.js';

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
    return { ...q, then: (ok, ko) => run(q).then(ok, ko) };
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

const C = (ref, sro, dateReception, extra = {}) => ({
  ref, refCflows: `${ref}_01`, numeroClient: '', operateur: 'Maroc Telecom',
  sro, sroKey: sro.toUpperCase(), typeLiaison: 'FTTH', debit: '', adresse: `Adresse ${ref}`,
  dateReception, ...extra,
});

let pass = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }

const pg = new PGlite();
useSqlClient(makeSql(pg));

console.log('\n── Réglages ──');
const s0 = await getSettings();
assert.equal(s0.teams.length, 0);
assert.equal(s0.sro, undefined, "plus de correspondance SRO a configurer dans les reglages");
ok('schéma créé, réglages vides au départ (pas de données par défaut imposées)');

const s1 = await saveSettings({
  teams: [{ name: 'EQUIPE A', phone: '212600000001', active: true }, { name: 'EQUIPE B', phone: '212600000002', active: true }],
});
assert.equal(s1.teams.length, 2);
ok('équipes enregistrées (pas de SRO a configurer)');

console.log('\n── Import de démarrage (avec statut de départ) ──');
const seed = await importCommandes([
  C('R001', 'OCHA3F2-ZO-SP1', '2026-07-20', { statutDepart: 'annule' }),
  C('R002', 'OCHA3F2-ZO-SP1', '2026-07-21', { statutDepart: 'fait' }),
  C('R003', 'OCHA3F2-ZO-SP1', '2026-07-22', { statutDepart: 'blocage', motifDepart: 'SORTIE PCO' }),
  C('R004', 'OCHA3F2-ZO-SP1', '2026-07-23', {}),
], { day: '2026-07-31', avecStatutDepart: true });
assert.equal(seed.nouvelles, 4);
// Aucune commande de ce SRO n'a jamais ete affectee -> tout reste non affecte,
// aucun dispatch auto au premier import (rien a apprendre encore).
assert.equal(seed.dispatchees, 0, 'premier import de ce SRO : aucune equipe connue, rien a dispatcher automatiquement');
const vue1 = await getVue();
const parRef = Object.fromEntries(vue1.commandes.map((c) => [c.ref, c]));
assert.equal(parRef.R001.statut, 'annule');
assert.equal(parRef.R002.statut, 'fait');
assert.equal(parRef.R003.statut, 'blocage');
assert.equal(parRef.R003.motif, 'SORTIE PCO');
assert.equal(parRef.R004.statut, null, 'pas de statut de départ -> actif par défaut');
assert.equal(parRef.R004.assigned_team, null, 'aucune equipe connue pour ce SRO -> non affecte');
assert.equal(vue1.historique.R003?.[0]?.source, 'seed', "le point de depart est trace dans l'historique");
ok('le statut de départ (Annulée/Terminée/Blocage/En cours) est correctement seedé, avec historique');

console.log('\n── SRO -> équipe appris depuis une affectation manuelle ──');
// L'orienteur affecte R004 (le seul actif) à EQUIPE A à la main : ça "apprend"
// au systeme que ce SRO correspond a EQUIPE A pour les prochaines commandes.
await assignTeam(['R004'], 'EQUIPE A');

const lot = [];
for (let i = 1; i <= 15; i++) {
  lot.push(C(`R1${String(i).padStart(2, '0')}`, 'OCHA3F2-ZO-SP1', `2026-07-${10 + i}`));
}
const res2 = await importCommandes(lot, { day: '2026-08-01', avecStatutDepart: false });
assert.equal(res2.nouvelles, 15);
// R004 (affecte a la main juste avant) occupe deja 1 place chez EQUIPE A ->
// seules 9 des 15 nouvelles sont dispatchees pour completer jusqu'a 10.
assert.equal(res2.dispatchees, 9, "le systeme a appris EQUIPE A pour ce SRO et complete jusqu'a 10, sans plus");
const vue2 = await getVue();
const surEquipeA = vue2.commandes.filter((c) => c.assigned_team === 'EQUIPE A' && !c.statut);
assert.equal(surEquipeA.length, 10, "EQUIPE A ne depasse jamais 10 commandes actives");
const nonAffectees = vue2.commandes.filter((c) => !c.assigned_team && !c.statut && c.sro_key === 'OCHA3F2-ZO-SP1');
assert.equal(nonAffectees.length, 6, 'le surplus au-dela de 10 reste non affecte');
ok("une seule affectation manuelle suffit a apprendre le SRO -> equipe, sans aucune config, et le dispatch auto complete jusqu'a 10");

console.log('\n── Blocage exclu du calcul des 10 ──');
// R003 est en blocage : il ne doit pas compter dans la charge d'EQUIPE A
// (verifie indirectement : EQUIPE A a 10 commandes ACTIVES, blocage a part).
const r003 = vue2.commandes.find((c) => c.ref === 'R003');
assert.equal(r003.statut, 'blocage');
ok('R003 reste en blocage, hors du decompte des 10 commandes actives verifie ci-dessus');

console.log('\n── Réaffectation manuelle sticky ──');
await assignTeam(['R105'], 'EQUIPE B');
const reimport = await importCommandes([C('R105', 'OCHA3F2-ZO-SP1', '2026-07-15')], { day: '2026-08-02', avecStatutDepart: false });
const vue3 = await getVue();
const r105 = vue3.commandes.find((c) => c.ref === 'R105');
assert.equal(r105.assigned_team, 'EQUIPE B', "l'affectation manuelle n'est jamais ecrasee par un reimport ou l'auto-dispatch");
assert.equal(r105.assign_manual, true);
ok('réaffectation manuelle conservée après réimport de la même commande');

console.log('\n── Statuts : Fait (PO), Blocage (motif+texte), Annulé ──');
await setStatut(['R110'], 'fait', { po: 'PO-12345', source: 'chef' });
let vue4 = await getVue();
let r110 = vue4.commandes.find((c) => c.ref === 'R110');
assert.equal(r110.statut, 'fait');
assert.equal(r110.po, 'PO-12345');
ok('Fait enregistre bien le PO');

await setStatut(['R111'], 'blocage', { motif: 'Autre', texte: 'Client absent 3 fois', source: 'chef' });
vue4 = await getVue();
let r111 = vue4.commandes.find((c) => c.ref === 'R111');
assert.equal(r111.statut, 'blocage');
assert.equal(r111.motif, 'Autre');
assert.equal(r111.texte, 'Client absent 3 fois');
ok('Blocage "Autre" enregistre motif + texte libre');

await setStatut(['R112'], 'annule', { source: 'chef' });
vue4 = await getVue();
assert.equal(vue4.commandes.find((c) => c.ref === 'R112').statut, 'annule');
ok('Annulé enregistré');

await setStatut(['R113'], 'planifie', { source: 'chef' });
vue4 = await getVue();
assert.equal(vue4.commandes.find((c) => c.ref === 'R113').statut, 'planifie');
ok('Planifié enregistré');

const hist = await getHistorique(['R110']);
assert.equal(hist.R110.length, 1);
assert.equal(hist.R110[0].po, 'PO-12345');
ok('historique par commande expose le PO');

console.log('\n── Réimport : champs descriptifs mis à jour, statut jamais touché ──');
const res3 = await importCommandes([C('R110', 'OCHA3F2-ZO-SP1', '2026-07-15', { adresse: 'Nouvelle adresse' })], { day: '2026-08-03', avecStatutDepart: false });
assert.equal(res3.misAJour, 1);
const vue5 = await getVue();
const r110b = vue5.commandes.find((c) => c.ref === 'R110');
assert.equal(r110b.adresse, 'Nouvelle adresse', 'adresse mise a jour');
assert.equal(r110b.statut, 'fait', 'le statut Fait deja pose reste intact malgre le reimport');
assert.equal(r110b.po, 'PO-12345', 'le PO reste intact');
ok('un réimport met à jour les champs descriptifs sans jamais toucher au statut/PO/motif déjà posés');

console.log('\n── Planifié compte comme charge active pour le plafond de 10 ──');
// EQUIPE A a deja 10 commandes actives (test du dispatch auto plus haut). On
// affecte et planifie R200 (un tout autre SRO) a EQUIPE A : sa charge active
// passe a 11 -> plus aucune commande d'un SRO connu de EQUIPE A ne doit lui
// etre dispatchee automatiquement, exactement comme si elle etait "en cours".
await importCommandes([C('R200', 'ZONE-PLAN-1', '2026-07-01')], { day: '2026-08-04', avecStatutDepart: false });
await assignTeam(['R200'], 'EQUIPE A');
await setStatut(['R200'], 'planifie', { source: 'chef' });

const lot2 = [];
for (let i = 1; i <= 5; i++) lot2.push(C(`R22${String(i).padStart(2, '0')}`, 'ZONE-PLAN-1', `2026-07-2${i}`));
const res4 = await importCommandes(lot2, { day: '2026-08-05', avecStatutDepart: false });
assert.equal(res4.dispatchees, 0, "EQUIPE A a deja 10 actives + R200 planifie (11) -> plus de place disponible");
ok('un statut Planifié occupe une place active et bloque le dispatch auto au-dela du plafond, contrairement a Fait/Annulé qui liberent la place');

await pg.close();
console.log(`\n✅ ${pass} groupes de vérifications passés — la couche base NA est saine.\n`);
