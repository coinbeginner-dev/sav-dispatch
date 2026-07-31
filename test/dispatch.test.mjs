// Parsing du fichier SAV (parseTickets) : détection des colonnes et du
// regroupement splitter, sans dépendance à un fichier réel.
// Lancer avec : npm run test:dispatch
import assert from 'node:assert/strict';
import { parseTickets } from '../lib/dispatch.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

console.log('\n── Format habituel (colonne "Avancement") ──');
const ancien = parseTickets([
  ['N° Réclam.', 'ND', 'Client', 'OLT/MSAN', 'Enreg.', 'Délai(j)', 'Famille', 'Contact', 'Adresse', 'Avancement', 'Tranche'],
  ['R100001', 'nd1', 'CLIENT A', 'MNOC-TAOUZAR', '20/07', 1.2, 'Pas de Synchro', '0600', 'CASA', 'SPLT TAOUZAR:1-1-1-1 ISOLE', 'HD'],
  ['R100002', 'nd2', 'CLIENT B', 'MNOC-TAOUZAR', '20/07', 1.1, 'Pas de Synchro', '0600', 'CASA', 'SPLT TAOUZAR:1-1-1-1 ISOLE', 'HD'],
  ['R100003', 'nd3', 'CLIENT C', 'MNOC-TAOUZAR', '20/07', 0.5, 'Lenteur', '0600', 'CASA', 'En cours', 'DD'],
]);
assert.equal(ancien.errors.length, 0);
assert.equal(ancien.tickets.length, 3);
assert.equal(ancien.tickets[0].splitter, 'TAOUZAR:1-1-1-1', 'splitter extrait de la colonne Avancement');
assert.equal(ancien.tickets[2].splitter, null, '"En cours" (pas ISOLE) -> pas de splitter');
assert.equal(ancien.tickets[0].famille, 'Pas de Synchro');
ok('fichier au format habituel : splitter et famille lus depuis Avancement, inchangé');

console.log('\n── Nouveau format GPON (pas de colonne "Avancement", splitter renommé "Splitter") ──');
const nouveau = parseTickets([
  ['N° Réclam.', 'ND', 'Client', 'ZR', 'OLT/MSAN', 'Date Enreg.', 'Délai(j)', 'Contact client', 'ADRESSE', 'Splitter', 'EQUIPE', 'TRANCHE'],
  ['R200001', 'nd1', 'CLIENT D', 'ZR1', 'MZIC-Fadl2-3', '30/07', 2.3, '0600', 'CASA', 'SPLT Fadl2-2:1-1-19-1 ISOLE', '3GCOM', '>48H'],
  ['R200002', 'nd2', 'CLIENT E', 'ZR1', 'MZIC-Fadl2-3', '30/07', 2.1, '0600', 'CASA', 'SPLT Fadl2-2:1-1-19-1 ISOLE', '3GCOM', '>48H'],
  ['R200003', 'nd3', 'CLIENT F', 'ZR2', 'MNOC-TAOUZAR', '30/07', 0.4, '0600', 'CASA', 'En cours', '3GCOM', '<24H'],
]);
assert.equal(nouveau.errors.length, 0);
assert.equal(nouveau.tickets.length, 3);
assert.equal(nouveau.tickets[0].splitter, 'Fadl2-2:1-1-19-1',
  'sans colonne Avancement, le parseur retombe sur la colonne Splitter pour détecter le regroupement');
assert.equal(nouveau.tickets[1].splitter, 'Fadl2-2:1-1-19-1');
assert.equal(nouveau.tickets[2].splitter, null, '"En cours" (pas ISOLE) -> pas de splitter, même dans ce format');
assert.equal(nouveau.tickets[0].msan, 'MZIC-Fadl2-3', 'OLT/MSAN toujours détecté');
assert.equal(nouveau.tickets[0].famille, '', 'pas de colonne Famille dans ce format -> vide, pas d\'erreur');
ok('nouveau format sans colonne Avancement : le splitter est quand même détecté via la colonne Splitter');

console.log(`\n✅ ${pass} groupes de vérifications passés — parsing des fichiers SAV prêt.\n`);
