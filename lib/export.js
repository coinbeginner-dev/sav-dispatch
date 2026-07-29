// ─────────────────────────────────────────────────────────────
// Construction des lignes de l'export Excel : logique pure, sans DOM ni
// dépendance à ExcelJS, pour pouvoir vérifier la priorité des couleurs et
// le contenu des colonnes sans navigateur.
// ─────────────────────────────────────────────────────────────

const LIBELLE = {
  fait: 'Fait',
  planifie: 'Planifié Connect',
  blocage: 'Blocage',
  // anciennes valeurs encore présentes dans l'historique
  pas_acces: "Pas d'accès",
  reporte: 'Reporté',
};

// Couleur d'une ligne : priorité au statut posé (fait/planifié/blocage),
// puis à l'arbitrage, puis au retard — mêmes règles que les cartes à l'écran.
export function statutCouleur(ticket, statut) {
  if (statut?.statut === 'fait') return 'fait';
  if (statut?.statut === 'planifie') return 'planifie';
  if (statut?.statut === 'blocage') return 'blocage';
  if (ticket.hors_dispatch) return 'hors_dispatch';
  if (ticket.delai >= 2) return 'rouge';
  if (ticket.delai >= 1) return 'orange';
  return 'vert';
}

export function ligneExport(t, { assign, statuts, reports }) {
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
    cle: statutCouleur(t, st),
  };
}

export function lignesExport(tickets, ctx) {
  return tickets.map((t) => ligneExport(t, ctx));
}
