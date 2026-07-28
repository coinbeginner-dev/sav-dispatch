// Lecture des retours WhatsApp des chefs d'équipe.
// Règle testée en priorité : rien n'est enregistré sans numéro de ticket exact.
// Lancer avec : npm run test:extraction
import assert from 'node:assert/strict';
import {
  normaliser, detecterStatut, refsCitees, analyser,
  messageConfirmation, estConfirmation,
} from '../lib/extraction.js';

let pass = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };

// Extrait réel de la journée du 28/07 (secteur Haddaouia)
const TICKETS = [
  { ref: 'R341024219', client: 'FATIMA CHERATE', msan: 'MNOC-TAOUZAR' },
  { ref: 'R340835007', client: 'FACULTED LETTRES ET SCIENCES HUMAINES AIN CHOC', msan: 'MNOC-TAOUZAR' },
  { ref: 'R340875265', client: 'MOHAMED ZOUHAIR', msan: 'GA-C-COLLINE-1' },
  { ref: 'R341060335', client: 'MOHAMED ZOUHAIR', msan: 'MZIC-Fadl2-3' },  // même client, 2 tickets
];

console.log('\n── Numéro de ticket : format strict ──');
assert.deepEqual(refsCitees('R341024219 fait', TICKETS), ['R341024219']);
assert.deepEqual(refsCitees('r341024219 fait', TICKETS), ['R341024219'], 'minuscules acceptées');
assert.deepEqual(refsCitees('E341024219 fait', TICKETS), [], 'lettre erronée REFUSÉE');
assert.deepEqual(refsCitees('341024219 fait', TICKETS), [], 'sans lettre REFUSÉ');
assert.deepEqual(refsCitees('R 341 024 219 fait', TICKETS), [], 'chiffres espacés REFUSÉS');
assert.deepEqual(refsCitees('R999999999 fait', TICKETS), [], 'ticket inexistant refusé');
assert.deepEqual(refsCitees('rappelle le 0661234567', TICKETS), [], 'un téléphone n’est pas un ticket');
ok('seul le numéro exact et existant est accepté');

console.log('\n── Détection du statut ──');
assert.equal(detecterStatut('R341024219 fait'), 'fait');
assert.equal(detecterStatut('cloturé'), 'fait');
assert.equal(detecterStatut('khlas'), 'fait');
assert.equal(detecterStatut('client absent'), 'pas_acces');
assert.equal(detecterStatut('ma jawbch'), 'pas_acces');
assert.equal(detecterStatut('reporté demain'), 'reporte');
assert.equal(detecterStatut('il faut une nacelle'), 'reporte');
assert.equal(detecterStatut('bonjour'), null, 'aucun statut inventé');
ok('français, darija translittérée, et absence de statut');

console.log('\n── Aucun rapprochement par nom de client ──');
const parNom = analyser('Mohamed Zouhair cloturé', TICKETS);
assert.equal(parNom.instructions.length, 0, 'le nom seul ne désigne aucun ticket');
assert.deepEqual(parNom.ignorees, ['Mohamed Zouhair cloturé']);
assert.match(messageConfirmation(parNom), /Sans numéro de ticket/);
ok('un nom de client ne suffit jamais — deux tickets ouverts pour Mohamed Zouhair');

console.log('\n── Message réel reçu ce soir ──');
const recu = analyser('E341024219 fait', TICKETS);
assert.equal(recu.instructions.length, 0, 'la faute de frappe sur la lettre est refusée');
assert.match(messageConfirmation(recu), /R341024219 fait/, 'la réponse rappelle le format attendu');
ok('« E341024219 fait » est refusé et le chef reçoit le format à utiliser');

console.log('\n── Cas nominal ──');
const bon = analyser('R341024219 fait', TICKETS);
assert.equal(bon.instructions.length, 1);
assert.equal(bon.instructions[0].ref, 'R341024219');
assert.equal(bon.instructions[0].statut, 'fait');
assert.equal(bon.instructions[0].ticket.client, 'FATIMA CHERATE');
assert.match(messageConfirmation(bon), /FATIMA CHERATE : fait/);
assert.match(messageConfirmation(bon), /C'est bon \?/);
ok('numéro + statut : instruction prête, confirmation demandée');

console.log('\n── Plusieurs tickets dans un seul message ──');
const multi = analyser('R341024219 fait\nR340875265 client absent\nR340835007 reporté nacelle', TICKETS);
assert.equal(multi.instructions.length, 3);
assert.deepEqual(multi.instructions.map((i) => i.statut), ['fait', 'pas_acces', 'reporte']);
assert.equal(multi.ignorees.length, 0);
ok('une ligne par ticket, trois statuts différents');

console.log('\n── Lignes incomplètes ou parasites ──');
const melange = analyser('R341024219 fait\nles autres je sais pas encore', TICKETS);
assert.equal(melange.instructions.length, 1, 'la ligne valide est retenue');
assert.equal(melange.ignorees.length, 1, "la ligne sans numéro est signalée, pas devinée");
const sansStatut = analyser('R341024219', TICKETS);
assert.equal(sansStatut.instructions[0].statut, null);
assert.match(messageConfirmation(sansStatut), /fait, pas d’accès, ou reporté/);
ok('ligne valide conservée, ligne floue signalée, statut manquant redemandé');

console.log('\n── Note vocale et photo ──');
assert.match(messageConfirmation(analyser('', TICKETS), 'audio'), /en texte, avec le numéro de ticket/);
assert.match(messageConfirmation(analyser('', TICKETS), 'image'), /en texte, avec le numéro de ticket/);
ok('un vocal ou une photo ne déclenche aucune écriture');

console.log('\n── Réponse du chef ──');
assert.equal(estConfirmation('oui'), true);
assert.equal(estConfirmation('wah'), true);
assert.equal(estConfirmation('non'), false);
assert.equal(estConfirmation('machi'), false);
assert.equal(estConfirmation('R340875265 aussi'), null, 'ni oui ni non → nouveau message');
ok('oui / non en français et darija, et cas indécidable');

console.log(`\n✅ ${pass} groupes de vérifications passés — lecture des retours prête.\n`);
