// ─────────────────────────────────────────────────────────────
// Construction des lignes de l'export Excel : logique pure, sans DOM ni
// dépendance à ExcelJS, pour pouvoir vérifier la priorité des couleurs et
// le contenu des colonnes sans navigateur.
// ─────────────────────────────────────────────────────────────

const LIBELLE = {
  fait: 'Fait',
  planifie: 'Planifié Connect',
  blocage: 'Blocage',
  // Clos administrativement avec motif, distinct d'un "Fait" réel.
  clos: 'Clos',
  // anciennes valeurs encore présentes dans l'historique
  pas_acces: "Pas d'accès",
  reporte: 'Reporté',
  reouvert: 'Réouvert',
};

// Couleur d'une ligne : priorité au statut posé (fait/planifié/blocage/clos),
// puis à l'arbitrage, puis au retard — mêmes règles que les cartes à l'écran.
export function statutCouleur(ticket, statut) {
  if (statut?.statut === 'fait') return 'fait';
  if (statut?.statut === 'planifie') return 'planifie';
  if (statut?.statut === 'blocage') return 'blocage';
  if (statut?.statut === 'clos') return 'clos';
  if (ticket.hors_dispatch) return 'hors_dispatch';
  if (ticket.delai >= 2) return 'rouge';
  if (ticket.delai >= 1) return 'orange';
  return 'vert';
}

// Historique complet d'un ticket en une seule cellule, une ligne par retour
// terrain avec sa date — pour retrouver tout le vécu du ticket sans avoir à
// rouvrir l'appli, directement dans le fichier qu'on partage.
function historiqueTexte(notes) {
  if (!notes?.length) return '';
  return notes.map((n) => {
    let ligne = `${n.le} · ${LIBELLE[n.statut] || n.statut}`;
    if (n.motif) ligne += ` · ${n.motif}`;
    if (n.texte) ligne += ` « ${n.texte} »`;
    return ligne;
  }).join('\n');
}

// `nGroupe` = nombre de tickets du fichier partageant le même splitter que
// `t` (fourni par lignesExport, qui seul a la vue d'ensemble). Permet de
// repérer, directement dans le fichier partagé, les tickets résolus d'un
// seul coup par une même intervention splitter.
export function ligneExport(t, { assign, statuts, reports, historique }, nGroupe = 0) {
  const st = statuts[t.ref];
  const statutTexte = st
    ? (LIBELLE[st.statut] || st.statut)
    : (t.hors_dispatch ? 'En arbitrage' : 'En attente');
  return {
    ref: t.ref,
    client: t.client,
    contact: t.contact,
    msan: t.msan,
    famille: t.famille,
    adresse: t.adresse,
    delai: Number((t.delai || 0).toFixed(1)),
    tranche: t.tranche,
    equipe: assign[t.ref] || '',
    statut: statutTexte,
    motif: st?.motif || '',
    precision: st?.texte || '',
    source: st?.source || '',
    maj: st?.at ? new Date(st.at).toLocaleString('fr-FR') : '',
    hors: t.hors_dispatch ? 'Oui' : 'Non',
    reporte: reports[t.ref] || '',
    historique: historiqueTexte((historique || {})[t.ref]),
    splitter: t.splitter || '',
    ticketsLies: nGroupe > 1 ? nGroupe : '',
    envoye: t.envoye_le ? new Date(t.envoye_le).toLocaleString('fr-FR') : '',
    cle: statutCouleur(t, st),
  };
}

export function lignesExport(tickets, ctx) {
  const parSplitter = {};
  for (const t of tickets) if (t.splitter) parSplitter[t.splitter] = (parSplitter[t.splitter] || 0) + 1;
  return tickets.map((t) => ligneExport(t, ctx, parSplitter[t.splitter] || 0));
}
