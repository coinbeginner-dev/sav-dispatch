// Extraction des statuts depuis les messages libres des chefs d'équipe.
// Les échantillons viennent de vrais messages envoyés pendant les tests,
// plus des tournures darija telles qu'elles s'écrivent au clavier.
// Lancer avec : npm run test:extraction
import assert from 'node:assert/strict';
import {
  normaliser, detecterStatut, refsCitees, analyser,
  messageConfirmation, estConfirmation,
} from '../lib/extraction.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

// Extrait réaliste de la journée du 28/07 (secteur Haddaouia)
const TICKETS = [
  { ref: 'R341024219', client: 'TAOUFIK JAAFARI', msan: 'MNOC-TAOUZAR', delai: 3.5 },
  { ref: 'R340835007', client: 'FACULTED LETTRES ET SCIENCES HUMAINES AIN CHOC', msan: 'MNOC-TAOUZAR', delai: 6.4 },
  { ref: 'R340875265', client: 'MOHAMED ZOUHAIR', msan: 'GA-C-COLLINE-1', delai: 6.1 },
  { ref: 'R341009189', client: 'SOUFIANE KERTAOUI', msan: 'MZIC-Inara4-1', delai: 4.1 },
  { ref: 'R341060335', client: 'LEILA LAHLOU', msan: 'MZIC-Fadl2-3', delai: 3.2 },
  { ref: 'R341071511', client: 'MOHAMED BENANI', msan: 'GA-C-COLLINE-1', delai: 3.1 },
];

console.log('\n── Normalisation ──');
assert.equal(normaliser('Clôturé  ÉÀÇ'), 'cloture eac');
assert.equal(normaliser("Ticket R341024219 fait !"), 'ticket r341024219 fait');
ok('accents, ponctuation et espaces multiples');

console.log('\n── Détection du statut ──');
assert.equal(detecterStatut('Ticket R341024219 fait'), 'fait');
assert.equal(detecterStatut('Ticket Leila Lahlou cloturé'), 'fait');
assert.equal(detecterStatut('salina dyal la faculte'), 'fait');
assert.equal(detecterStatut('khlas hadak'), 'fait');
assert.equal(detecterStatut('makanch chi hedd'), 'pas_acces');
assert.equal(detecterStatut('client absent'), 'pas_acces');
assert.equal(detecterStatut('ma jawbch f telephone'), 'pas_acces');
assert.equal(detecterStatut('reporté à demain'), 'reporte');
assert.equal(detecterStatut('ghedda inchaallah'), 'reporte');
assert.equal(detecterStatut('il faut une nacelle'), 'reporte');
assert.equal(detecterStatut('bonjour ça va'), null, 'aucun marqueur → pas de statut inventé');
ok('français, darija translittérée et absence de statut');

console.log('\n── Référence de ticket citée ──');
assert.deepEqual(refsCitees('Ticket R341024219 fait', TICKETS), ['R341024219']);
assert.deepEqual(refsCitees('r341024219 et R340875265 ok', TICKETS), ['R341024219', 'R340875265']);
assert.deepEqual(refsCitees('R 341 024 219 fait', TICKETS), ['R341024219'], 'chiffres dictés avec espaces');
assert.deepEqual(refsCitees('R999999999 fait', TICKETS), [], 'référence inconnue ignorée');
ok('références explicites, espacées, et rejet des inconnues');

console.log('\n── Vrais messages envoyés pendant les tests ──');
const a1 = analyser('Ticket R341024219 fait', TICKETS);
assert.equal(a1.statut, 'fait');
assert.equal(a1.confiance, 'certaine');
assert.equal(a1.candidats[0].ref, 'R341024219');

const a2 = analyser('Ticket Leila Lahlou cloturé', TICKETS);
assert.equal(a2.statut, 'fait');
assert.equal(a2.confiance, 'probable');
assert.equal(a2.candidats[0].ref, 'R341060335', 'retrouvé par le nom du client');
ok('les deux messages réels de Soufiane sont correctement interprétés');

console.log('\n── Darija sans référence ──');
const a3 = analyser('salina dyal la faculte', TICKETS);
assert.equal(a3.statut, 'fait');
assert.equal(a3.candidats[0].ref, 'R340835007', 'la faculté reconnue par le nom du client');

const a4 = analyser('taouzar makanch chi hedd', TICKETS);
assert.equal(a4.statut, 'pas_acces');
assert.equal(a4.confiance, 'ambigue', 'deux tickets sur ce MSAN → confirmation requise');
assert.equal(a4.candidats.length, 2);

const a5 = analyser('mohamed zouhair khlas', TICKETS);
assert.equal(a5.statut, 'fait');
assert.equal(a5.candidats[0].ref, 'R340875265');
ok('darija : nom de client, zone ambiguë, mélange français/darija');

console.log('\n── Cas où il ne faut surtout rien décider ──');
const a6 = analyser('bonjour', TICKETS);
assert.equal(a6.confiance, 'aucune');
assert.equal(a6.candidats.length, 0);

const a7 = analyser('mohamed fait', TICKETS);
assert.equal(a7.confiance, 'ambigue', 'prénom partagé par deux clients');
assert.ok(a7.candidats.length >= 2);
ok('message vague et prénom ambigu : aucune décision automatique');

console.log('\n── Messages de confirmation ──');
assert.match(messageConfirmation(a1), /R341024219.*fait.*C'est bon/s);
assert.match(messageConfirmation(a4), /Plusieurs tickets/);
assert.match(messageConfirmation(a6), /pas compris/);
const sansStatut = analyser('R341024219', TICKETS);
assert.match(messageConfirmation(sansStatut), /c'est fait, pas d'accès, ou reporté/);
ok('confirmation adaptée : validation, choix, ou relance');

console.log('\n── Réponse du chef ──');
assert.equal(estConfirmation('oui'), true);
assert.equal(estConfirmation('wah'), true);
assert.equal(estConfirmation('safi'), true);
assert.equal(estConfirmation('non'), false);
assert.equal(estConfirmation('machi'), false);
assert.equal(estConfirmation('R340875265 aussi'), null, 'ni oui ni non → nouveau message à analyser');
ok('oui / non en français et darija, et cas indécidable');

console.log(`\n✅ ${pass} groupes de vérifications passés — extraction prête à être branchée.\n`);
