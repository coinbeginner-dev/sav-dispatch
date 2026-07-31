// Parsing du fichier "Commandes" NA + SLA 48h + suggestion SRO→équipe.
// Lancer avec : npm run test:na-dispatch
import assert from 'node:assert/strict';
import { parseCommandes, slaClass, suggestTeamBySro, normSro } from '../lib/na-dispatch.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

console.log('\n── Import de démarrage (avec Statut Connect / Status Rafik) ──');
const depart = parseCommandes([
  ['Date réception commande', 'Réf commande', 'Réf CFlows', 'Status Rafik', 'Statut Connect', 'Opérateur', 'SRO', 'Adresse'],
  ['23/07/2026 12:27', '101385728', '101385728_01', null, 'Annulée', 'Maroc Telecom', 'OCHA3F2-ZO-SP1', 'CASA'],
  ['24/07/2026 09:00', '101385729', '101385729_01', null, 'Intervention Terminée', 'Maroc Telecom', 'OCHA3F2-ZO-SP1', 'CASA'],
  ['25/07/2026 10:00', '101385730', '101385730_01', 'SORTIE PCO', 'Blocage', 'Maroc Telecom', 'OCHA3F2-ZO-SP1', 'CASA'],
  ['26/07/2026 11:00', '101385731', '101385731_01', null, 'En cours', 'Maroc Telecom', 'OCHA3F2-ZO-SP1', 'CASA'],
]);
assert.equal(depart.errors.length, 0);
assert.equal(depart.avecStatutDepart, true, 'colonne Statut Connect présente -> import de démarrage détecté');
assert.equal(depart.commandes.length, 4);
assert.equal(depart.commandes[0].statutDepart, 'annule');
assert.equal(depart.commandes[1].statutDepart, 'fait');
assert.equal(depart.commandes[2].statutDepart, 'blocage');
assert.equal(depart.commandes[2].motifDepart, 'SORTIE PCO');
assert.equal(depart.commandes[3].statutDepart, null, '"En cours" -> pas de statut, actif par défaut');
assert.equal(depart.commandes[0].dateReception, '2026-07-23', 'date de réception convertie en ISO');
ok('les 4 valeurs Statut Connect se traduisent correctement, avec le motif de blocage');

console.log('\n── Imports suivants (sans les colonnes de démarrage) ──');
const suivant = parseCommandes([
  ['Date réception commande', 'Réf commande', 'Opérateur', 'SRO', 'Adresse'],
  ['28/07/2026 08:00', '101400000', 'Maroc Telecom', 'OCHA3F2-ZO-SP1', 'CASA'],
]);
assert.equal(suivant.avecStatutDepart, false, 'pas de colonne Statut Connect -> pas de statut de démarrage');
assert.equal(suivant.commandes[0].statutDepart, undefined, 'aucun statutDepart calculé sur les imports suivants');
ok('un import sans colonnes de démarrage ne calcule aucun statut initial');

console.log('\n── SLA 48h ──');
const maintenant = new Date('2026-07-31T12:00:00Z');
assert.equal(slaClass('2026-07-29T00:00:00'.slice(0, 10), maintenant).key, 'rouge', '>=48h -> rouge');
assert.equal(slaClass('2026-07-30T00:00:00'.slice(0, 10), maintenant).key, 'orange', '24-48h -> orange');
assert.equal(slaClass('2026-07-31T00:00:00'.slice(0, 10), maintenant).key, 'vert', '<24h -> vert');
ok('classification SLA 48h/24h cohérente avec la date de réception');

console.log('\n── Suggestion équipe par SRO ──');
const commandesSro = [{ ref: 'R1', sroKey: normSro('OCHA3F2-ZO-SP1') }, { ref: 'R2', sroKey: normSro('SRO-INCONNU') }];
const teams = [{ name: 'EQUIPE A', active: true }, { name: 'EQUIPE B', active: false }];
const zones = [{ sro: 'OCHA3F2-ZO-SP1', team: 'EQUIPE A' }, { sro: 'AUTRE', team: 'EQUIPE B' }];
const suggestion = suggestTeamBySro(commandesSro, zones, teams);
assert.equal(suggestion.R1, 'EQUIPE A');
assert.equal(suggestion.R2, null, 'SRO non mappé -> non affecté');
ok('le SRO suggère la bonne équipe, ou rien si inconnu / équipe inactive');

console.log(`\n✅ ${pass} groupes de vérifications passés — parsing NA prêt.\n`);
