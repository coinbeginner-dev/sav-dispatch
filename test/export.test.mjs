// Construction des lignes d'export (couleurs + libellés), sans Excel ni DOM.
// Lancer avec : npm run test:export
import assert from 'node:assert/strict';
import { statutCouleur, ligneExport, lignesExport } from '../lib/export.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

const T = (over = {}) => ({
  ref: 'R100', client: 'CLIENT TEST', contact: '0600', msan: 'MNOC-TAOUZAR',
  famille: 'FTTH', adresse: 'CASA', delai: 0.5, tranche: 'DD', hors_dispatch: false, ...over,
});

console.log('\n── Priorité des couleurs ──');
assert.equal(statutCouleur(T(), { statut: 'fait' }), 'fait');
assert.equal(statutCouleur(T({ hors_dispatch: true }), { statut: 'fait' }), 'fait',
  'un statut posé prime toujours sur hors_dispatch');
assert.equal(statutCouleur(T({ delai: 5 }), { statut: 'planifie' }), 'planifie',
  'un statut posé prime toujours sur le retard');
assert.equal(statutCouleur(T({ hors_dispatch: true }), null), 'hors_dispatch',
  'sans statut, hors_dispatch prime sur le retard');
assert.equal(statutCouleur(T({ delai: 2 }), null), 'rouge');
assert.equal(statutCouleur(T({ delai: 1.9 }), null), 'orange');
assert.equal(statutCouleur(T({ delai: 0.9 }), null), 'vert');
ok('statut posé > hors dispatch > retard, exactement comme sur les cartes');

console.log('\n── Contenu d\'une ligne ──');
const ctx = (statuts = {}) => ({ assign: { R100: 'MOHAMED LOKID' }, statuts, reports: { R100: 2 } });

const enAttente = ligneExport(T(), ctx());
assert.equal(enAttente.statut, 'En attente');
assert.equal(enAttente.equipe, 'MOHAMED LOKID');
assert.equal(enAttente.reporte, 2);
assert.equal(enAttente.cle, 'vert');
ok('ticket sans statut, pas hors dispatch : "En attente"');

const enArbitrage = ligneExport(T({ hors_dispatch: true }), ctx());
assert.equal(enArbitrage.statut, 'En arbitrage', 'distinct de "En attente" : celui-ci est déjà sorti du dispatch');
ok('ticket hors dispatch sans statut : "En arbitrage", pas "En attente"');

const fait = ligneExport(T(), ctx({ R100: { statut: 'fait', motif: null, texte: null, source: 'chef', at: '2026-07-29T10:00:00Z' } }));
assert.equal(fait.statut, 'Fait');
assert.match(fait.maj, /2026|29\/07|07\/29/, 'la date de mise à jour est formatée');
ok('statut Fait avec date de mise à jour');

const blocageAutre = ligneExport(T(), ctx({
  R100: { statut: 'blocage', motif: 'Autre', texte: 'Câble arraché par un tiers', source: 'whatsapp' },
}));
assert.equal(blocageAutre.statut, 'Blocage');
assert.equal(blocageAutre.motif, 'Autre');
assert.equal(blocageAutre.precision, 'Câble arraché par un tiers');
assert.equal(blocageAutre.source, 'whatsapp');
ok('blocage "Autre" : motif et texte libre conservés dans des colonnes séparées');

console.log('\n── Plusieurs tickets ──');
const lignes = lignesExport(
  [T({ ref: 'R1', delai: 3 }), T({ ref: 'R2', hors_dispatch: true })],
  { assign: {}, statuts: {}, reports: {} },
);
assert.equal(lignes.length, 2);
assert.equal(lignes[0].cle, 'rouge');
assert.equal(lignes[1].cle, 'hors_dispatch');
assert.equal(lignes[0].equipe, '', 'équipe absente du plan -> chaîne vide, pas undefined');
ok('lignesExport traite plusieurs tickets et préserve l\'ordre');

console.log(`\n✅ ${pass} groupes de vérifications passés — export prêt.\n`);
