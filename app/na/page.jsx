'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseCommandes, slaClass, buildTeamMessage, waLinkNa } from '../../lib/na-dispatch';
import { loadInitial, saveSettings, pushImport, pushStatut, pushAssign } from '../../lib/na-store';

const STATUT_LABEL = { fait: '✅ Fait', planifie: '📅 Planifié', blocage: '⛔ Blocage', annule: '🚫 Annulé' };
const MOTIFS_BLOCAGE = ['SORTIE PCO', 'Besoin Contact Client', 'INJOIGNABLE', 'TUBAGE COTE GAINE', 'DEJA INST', 'Autre'];
const CAPACITE_JOUR = 10;
// Noms d'opérateur tels qu'ils apparaissent dans le fichier -> libellé court
// affiché en tag. Un opérateur absent de cette liste s'affiche tel quel.
const OPERATEUR_LABEL = { 'Maroc Telecom': 'IAM', 'Orange Maroc': 'Orange', 'Inwi': 'INWI' };
const OPERATEUR_COLOR = { IAM: '#0070C0', Orange: '#E8841A', INWI: '#7A1FA2' };
function operateurLabel(op) { return OPERATEUR_LABEL[op] || op || '?'; }

export default function NaDashboard() {
  const [teams, setTeams] = useState([]);
  const [commandes, setCommandes] = useState([]);
  const [historique, setHistorique] = useState({});
  const [db, setDb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const [fileName, setFileName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [waCompose, setWaCompose] = useState(null);
  const [recherche, setRecherche] = useState('');
  const [voirBlocages, setVoirBlocages] = useState(true);
  const [voirNonAffectees, setVoirNonAffectees] = useState(true);
  const fileRef = useRef(null);

  useEffect(() => {
    loadInitial().then((s) => {
      setDb(s.db); setTeams(s.teams);
      setCommandes(s.commandes); setHistorique(s.historique);
      if (s.commandes.length) setFileName('commandes en base');
    });
  }, []);

  async function rafraichir() {
    setBusy(true);
    try {
      const s = await loadInitial();
      setDb(s.db); setTeams(s.teams);
      setCommandes(s.commandes); setHistorique(s.historique);
      if (s.commandes.length) setFileName('commandes en base');
    } finally { setBusy(false); }
  }

  const dateStr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const XLSX = await import('xlsx');
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { cellDates: true });
    const sheetName = wb.SheetNames.find((n) => n.toUpperCase().includes('COMMANDE')) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    const { commandes: parsed, errors: errs, avecStatutDepart } = parseCommandes(rows);
    e.target.value = '';
    setErrors(errs);
    if (!parsed.length) return;

    setBusy(true);
    try {
      const res = await pushImport(db, parsed, avecStatutDepart);
      setCommandes(res.commandes || []);
      setHistorique(res.historique || {});
      setErrors([...errs, `${res.nouvelles} nouvelle(s), ${res.misAJour} mise(s) à jour, ${res.dispatchees} auto-dispatchée(s)`]);
    } catch (err) {
      setErrors([...errs, `Import impossible (${err.message})`]);
    } finally {
      setBusy(false);
    }
  }

  function marquerStatut(refs, statut, extra = {}) {
    const next = commandes.map((c) => {
      if (!refs.includes(c.ref)) return c;
      if (!statut) { const { statut: _s, motif: _m, texte: _t, po: _p, ...rest } = c; return { ...rest, statut: null, motif: null, texte: null, po: null }; }
      return { ...c, statut, motif: extra.motif || null, texte: extra.texte || null, po: extra.po || null, source: 'chef' };
    });
    setCommandes(next);
    pushStatut(db, refs, statut, extra).catch((e) => alert(`Statut non enregistré : ${e.message}. Rafraîchis la page.`));
  }

  function reassign(ref, team) {
    setCommandes(commandes.map((c) => (c.ref === ref ? { ...c, assigned_team: team || null, assign_manual: true } : c)));
    pushAssign(db, [ref], team).catch((e) => alert(`Réaffectation non enregistrée : ${e.message}. Rafraîchis la page.`));
  }

  async function persistSettings(newTeams) {
    setTeams(newTeams);
    try {
      await saveSettings(db, newTeams);
    } catch (e) {
      alert(`Réglages non enregistrés : ${e.message}`);
      return;
    }
    if (db) await rafraichir();
  }

  const activeTeams = teams.filter((t) => t.active);
  const rechercheNorm = recherche.trim().toLowerCase();
  const correspond = (c) => c.ref.toLowerCase().includes(rechercheNorm)
    || (c.numero_client || '').toLowerCase().includes(rechercheNorm)
    || (c.adresse || '').toLowerCase().includes(rechercheNorm);

  const stats = useMemo(() => {
    const total = commandes.length;
    const fait = commandes.filter((c) => c.statut === 'fait').length;
    const annule = commandes.filter((c) => c.statut === 'annule').length;
    const blocage = commandes.filter((c) => c.statut === 'blocage').length;
    const planifie = commandes.filter((c) => c.statut === 'planifie').length;
    const cloture = fait + annule;
    const aTraiter = total - cloture - blocage - planifie;
    const rouge = commandes.filter((c) => !c.statut && slaClass(c.date_reception).key === 'rouge').length;
    const orange = commandes.filter((c) => !c.statut && slaClass(c.date_reception).key === 'orange').length;
    // Répartition par opérateur (IAM / Orange / INWI...) — pas seulement sur
    // le total, mais pour chaque compteur (milestone) du dashboard, pour
    // savoir combien de chaque opérateur est clôturé, planifié, à traiter...
    const parOperateurDe = (liste) => {
      const m = {};
      for (const c of liste) { const lbl = operateurLabel(c.operateur); m[lbl] = (m[lbl] || 0) + 1; }
      return m;
    };
    const parOperateur = parOperateurDe(commandes);
    const parOperateurCloture = parOperateurDe(commandes.filter((c) => c.statut === 'fait' || c.statut === 'annule'));
    const parOperateurPlanifie = parOperateurDe(commandes.filter((c) => c.statut === 'planifie'));
    const parOperateurBlocage = parOperateurDe(commandes.filter((c) => c.statut === 'blocage'));
    const parOperateurATraiter = parOperateurDe(commandes.filter((c) => !c.statut));
    return {
      total, fait, annule, blocage, planifie, cloture, aTraiter, rouge, orange,
      parOperateur, parOperateurCloture, parOperateurPlanifie, parOperateurBlocage, parOperateurATraiter,
    };
  }, [commandes]);

  const blocages = useMemo(
    () => commandes.filter((c) => c.statut === 'blocage' && (!rechercheNorm || correspond(c)))
      .sort((a, b) => (a.date_reception || '').localeCompare(b.date_reception || '')),
    [commandes, rechercheNorm],
  );

  const nonAffectees = useMemo(
    () => commandes.filter((c) => !c.statut && !c.assigned_team && (!rechercheNorm || correspond(c)))
      .sort((a, b) => (a.date_reception || '').localeCompare(b.date_reception || '')),
    [commandes, rechercheNorm],
  );

  // Planifié reste une commande active (juste programmée avec le client) :
  // elle reste visible dans le dispatch en cours, contrairement à Fait/Annulé
  // qui passent dans le tiroir "traités".
  const parEquipe = useMemo(() => {
    const map = {};
    for (const t of activeTeams) {
      map[t.name] = commandes
        .filter((c) => (!c.statut || c.statut === 'planifie') && c.assigned_team === t.name)
        .sort((a, b) => (a.date_reception || '').localeCompare(b.date_reception || ''));
    }
    return map;
  }, [commandes, activeTeams]);

  const traiteesParEquipe = useMemo(() => {
    const map = {};
    for (const t of activeTeams) {
      map[t.name] = commandes.filter((c) => (c.statut === 'fait' || c.statut === 'annule') && c.assigned_team === t.name);
    }
    return map;
  }, [commandes, activeTeams]);

  // KPI d'avancement par équipe : Total / Planifié / Fait / Blocage + le
  // compte par opérateur (IAM/Orange/INWI), calculés sur TOUTES les commandes
  // de l'équipe (y compris celles en blocage, qui ne sont pas dans sa colonne
  // active mais restent les siennes) — pas juste le total global.
  const statsParEquipe = useMemo(() => {
    const map = {};
    for (const t of activeTeams) {
      const siennes = commandes.filter((c) => c.assigned_team === t.name);
      const parOperateur = {};
      for (const c of siennes) {
        const lbl = operateurLabel(c.operateur);
        parOperateur[lbl] = (parOperateur[lbl] || 0) + 1;
      }
      map[t.name] = {
        total: siennes.length,
        planifie: siennes.filter((c) => c.statut === 'planifie').length,
        fait: siennes.filter((c) => c.statut === 'fait').length,
        blocage: siennes.filter((c) => c.statut === 'blocage').length,
        parOperateur,
      };
    }
    return map;
  }, [commandes, activeTeams]);

  function ouvrirEnvoi(teamName) {
    const team = teams.find((t) => t.name === teamName);
    if (!team?.phone) { alert(`Pas de numéro WhatsApp pour ${teamName}. Ajoute-le dans Réglages.`); return; }
    const liste = (parEquipe[teamName] || []).filter((c) => !rechercheNorm || correspond(c));
    if (!liste.length) { alert(`Aucune commande restante pour ${teamName}.`); return; }
    setWaCompose(teamName);
  }

  function envoyer(teamName, choisies) {
    const team = teams.find((t) => t.name === teamName);
    const msg = buildTeamMessage(teamName, choisies, dateStr);
    window.open(waLinkNa(team.phone, msg), '_blank');
    setWaCompose(null);
  }

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <span style={S.brand}>📡 <span style={{ color: '#0070C0' }}>NA</span></span>
          <span style={S.title}> Suivi &amp; Dispatch — FTTH Connect</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <nav style={{ display: 'flex', gap: 4, background: '#F5F7FA', borderRadius: 10, padding: 3 }}>
            <a href="/" style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, color: '#0F1B3D', textDecoration: 'none' }}>SAV</a>
            <span style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#0070C0', color: '#fff' }}>NA</span>
          </nav>
          <span style={S.date}>{dateStr}</span>
          <span style={db ? S.dbOn : S.dbOff}>{db ? '🟢 base connectée' : '🟡 mode local'}</span>
          {db && <button style={S.btnGhost} onClick={rafraichir} disabled={busy}>↻ Rafraîchir</button>}
          <button style={S.btnGhost} onClick={() => setShowSettings(true)}>⚙ Réglages</button>
          <a href="/api/logout" style={{ ...S.btnGhost, textDecoration: 'none' }}>Déconnexion</a>
        </div>
      </header>

      <section style={S.card}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={S.btnPrimary} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? '⏳ Enregistrement…' : '📂 Charger le fichier Commandes (.xlsx)'}
          </button>
          <input ref={fileRef} type="file" accept=".ods,.xlsx,.xls" style={{ display: 'none' }} onChange={onFile} />
          {fileName && <span style={{ fontSize: 13, color: '#556' }}>{fileName} — {commandes.length} commandes</span>}
          {errors.map((e, i) => <span key={i} style={S.warn}>⚠ {e}</span>)}
        </div>

        {commandes.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              <StatCard n={stats.total} l="Total" bg="#F5F7FA" c="#0F1B3D" detail={stats.parOperateur} />
              <StatCard n={stats.cloture} l={`Clôturé (fait ${stats.fait} · annulé ${stats.annule})`} bg="#EAFAF1" c="#00753A" detail={stats.parOperateurCloture} />
              <StatCard n={stats.planifie} l="Planifié" bg="#EAF3FA" c="#0070C0" detail={stats.parOperateurPlanifie} />
              <StatCard n={stats.aTraiter} l="À traiter" bg="#EAF3FA" c="#0070C0" detail={stats.parOperateurATraiter} />
              <StatCard n={stats.blocage} l="En blocage" bg="#FEF2F2" c="#C0392B" detail={stats.parOperateurBlocage} />
            </div>
            <div style={S.statRow}>
              <Stat n={stats.rouge} l="🔴 SLA dépassé (≥48h)" c="#C0392B" />
              <Stat n={stats.orange} l="🟠 24-48h" c="#B87700" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
              <input style={S.inputSm} placeholder="🔍 Chercher une réf, un n° client ou une adresse"
                value={recherche} onChange={(e) => setRecherche(e.target.value)} />
              {recherche.trim() && <button style={S.btnLink} onClick={() => setRecherche('')}>effacer</button>}
            </div>
          </>
        )}
      </section>

      {blocages.length > 0 && (
        <section style={{ ...S.card, borderLeft: '4px solid #C0392B' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ ...S.h3, color: '#C0392B', margin: 0 }}>⛔ Blocages en attente ({blocages.length})</h3>
            <button style={S.btnGhost} onClick={() => setVoirBlocages((v) => !v)}>
              {voirBlocages ? '▲ Réduire' : '▼ Afficher'}
            </button>
          </div>
          {voirBlocages && (
            <>
              <p style={S.hint}>Ces commandes sont bloquées sur le terrain — elles ne comptent pas dans les 10/jour et n'apparaissent pas dans les messages WhatsApp tant qu'elles restent en blocage.</p>
              {blocages.map((c) => (
                <CommandeRow key={c.ref} c={c} teams={activeTeams} onChange={(v) => reassign(c.ref, v)}
                  historique={historique[c.ref]} onStatut={(s, extra) => marquerStatut([c.ref], s, extra)} />
              ))}
            </>
          )}
        </section>
      )}

      {nonAffectees.length > 0 && (
        <section style={{ ...S.card, borderLeft: '4px solid #B87700' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ ...S.h3, color: '#B87700', margin: 0 }}>⚠ Non affectées ({nonAffectees.length}) — SRO inconnu ou équipe inactive</h3>
            <button style={S.btnGhost} onClick={() => setVoirNonAffectees((v) => !v)}>
              {voirNonAffectees ? '▲ Réduire' : '▼ Afficher'}
            </button>
          </div>
          {voirNonAffectees && nonAffectees.map((c) => (
            <CommandeRow key={c.ref} c={c} teams={activeTeams} onChange={(v) => reassign(c.ref, v)}
              historique={historique[c.ref]} onStatut={(s, extra) => marquerStatut([c.ref], s, extra)} />
          ))}
        </section>
      )}

      {commandes.length > 0 && (
        <section style={S.techGrid}>
          {activeTeams.map((team) => (
            <TeamColumn key={team.name} team={team} commandes={parEquipe[team.name] || []}
              traitees={traiteesParEquipe[team.name] || []} teams={activeTeams}
              stats={statsParEquipe[team.name]}
              onChange={reassign} onStatut={(refs, s, extra) => marquerStatut(refs, s, extra)}
              onSend={() => ouvrirEnvoi(team.name)} historique={historique} filtre={rechercheNorm} correspond={correspond} />
          ))}
        </section>
      )}

      {commandes.length === 0 && (
        <section style={{ ...S.card, textAlign: 'center', padding: 60, color: '#8892A4' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          Charge le fichier "Commandes" pour démarrer le suivi NA.
        </section>
      )}

      {showSettings && (
        <NaSettings teams={teams}
          onSave={(t) => { persistSettings(t); setShowSettings(false); }}
          onClose={() => setShowSettings(false)} />
      )}

      {waCompose && (
        <WaComposeModal teamName={waCompose}
          commandes={(parEquipe[waCompose] || []).filter((c) => !rechercheNorm || correspond(c))}
          onClose={() => setWaCompose(null)}
          onEnvoyer={(choisies) => envoyer(waCompose, choisies)} />
      )}
    </div>
  );
}

function StatCard({ n, l, bg, c, detail }) {
  return (
    <div style={{ background: bg, borderRadius: 10, padding: '10px 16px', minWidth: 130 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: c }}>{n}</div>
      <div style={{ fontSize: 11, color: '#556' }}>{l}</div>
      {detail && Object.keys(detail).length > 0 && (
        <div style={{ fontSize: 10, color: '#8892A4', marginTop: 4 }}>
          {Object.entries(detail).map(([lbl, v]) => `${lbl} ${v}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function Stat({ n, l, c }) {
  return (
    <div style={{ minWidth: 90 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{n}</div>
      <div style={{ fontSize: 11, color: '#8892A4' }}>{l}</div>
    </div>
  );
}

function TeamColumn({ team, commandes, traitees, teams, stats, onChange, onStatut, onSend, historique, filtre, correspond }) {
  const [voirTraitees, setVoirTraitees] = useState(false);
  const affichees = filtre ? commandes.filter(correspond) : commandes;
  const traiteesAffichees = filtre ? traitees.filter(correspond) : traitees;
  if (filtre && affichees.length === 0 && traiteesAffichees.length === 0) return null;
  const plein = commandes.length >= CAPACITE_JOUR;

  return (
    <div style={S.techCol}>
      <div style={S.techHead}>
        <div>
          <strong>{team.name}</strong>
          <span style={{ fontSize: 11, color: plein ? '#C0392B' : '#8892A4', marginLeft: 8 }}>
            {commandes.length}/{CAPACITE_JOUR}
          </span>
        </div>
        <button style={S.btnWa} onClick={onSend} disabled={!affichees.length}>📱 WhatsApp</button>
      </div>
      {stats && (
        <>
          <div style={{ fontSize: 11, color: '#556', marginBottom: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
            <span>Total <strong>{stats.total}</strong></span>
            <span style={{ color: '#0070C0' }}>Planifié <strong>{stats.planifie}</strong></span>
            <span style={{ color: '#00753A' }}>Fait <strong>{stats.fait}</strong></span>
            <span style={{ color: '#C0392B' }}>Blocage <strong>{stats.blocage}</strong></span>
          </div>
          <div style={{ fontSize: 11, color: '#8892A4', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
            {Object.entries(stats.parOperateur).map(([lbl, n]) => (
              <span key={lbl} style={{ color: OPERATEUR_COLOR[lbl] || '#8892A4' }}>{lbl} <strong>{n}</strong></span>
            ))}
          </div>
        </>
      )}
      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        {affichees.map((c) => (
          <CommandeRow key={c.ref} c={c} teams={teams} current={team.name} onChange={(v) => onChange(c.ref, v)}
            historique={historique[c.ref]} onStatut={(s, extra) => onStatut([c.ref], s, extra)} />
        ))}
        {traiteesAffichees.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #D7DCE5' }}>
            <button style={S.btnLink} onClick={() => setVoirTraitees(!voirTraitees)}>
              {voirTraitees ? 'masquer' : `✅ ${traiteesAffichees.length} traité(s) — afficher`}
            </button>
            {voirTraitees && traiteesAffichees.map((c) => (
              <CommandeRow key={c.ref} c={c} teams={teams} current={team.name} onChange={(v) => onChange(c.ref, v)}
                historique={historique[c.ref]} onStatut={(s, extra) => onStatut([c.ref], s, extra)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommandeRow({ c, teams, current, onChange, historique, onStatut }) {
  const [motifPour, setMotifPour] = useState(null);
  const [texteLibre, setTexteLibre] = useState('');
  const [voirHistorique, setVoirHistorique] = useState(false);
  const statut = c.statut;
  const sla = !statut ? slaClass(c.date_reception) : null;

  function validerFait() {
    const po = texteLibre.trim();
    if (!po) return;
    onStatut('fait', { po });
    setMotifPour(null); setTexteLibre('');
  }
  function validerBlocageAutre() {
    const t = texteLibre.trim();
    if (!t) return;
    onStatut('blocage', { motif: 'Autre', texte: t });
    setMotifPour(null); setTexteLibre('');
  }

  const opLbl = operateurLabel(c.operateur);

  return (
    <div style={{
      ...S.job,
      background: statut ? (statut === 'fait' ? '#EAFAF1' : statut === 'annule' ? '#F5F7FA' : statut === 'planifie' ? '#EAF3FA' : '#FEF2F2') : (sla?.bg || '#fff'),
      borderLeft: `4px solid ${statut ? (statut === 'fait' ? '#00963F' : statut === 'annule' ? '#8892A4' : statut === 'planifie' ? '#0070C0' : '#C0392B') : (sla?.color || '#D7DCE5')}`,
      opacity: statut === 'fait' || statut === 'annule' ? 0.85 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0F1B3D' }}>
            {c.ref}
            <span style={{
              marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#fff',
              background: OPERATEUR_COLOR[opLbl] || '#8892A4', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle',
            }}>{opLbl}</span>
          </div>
          {!statut && sla && <div style={{ fontSize: 12, color: sla.color, fontWeight: 600 }}>{sla.label}</div>}
          <div style={{ fontSize: 12, color: '#556' }}>
            {c.adresse || '—'}{c.sro ? ` · SRO ${c.sro}` : ''}
          </div>
          {c.numero_client && <div style={{ fontSize: 11, color: '#8892A4' }}>Client : {c.numero_client}</div>}
        </div>
        {onChange && teams && (
          <select value={current || c.assigned_team || ''} onChange={(e) => onChange(e.target.value)} style={S.select}>
            <option value="">— non affecté —</option>
            {teams.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        )}
      </div>

      {statut && (
        <div style={S.statutBar}>
          <span style={{ fontWeight: 700, color: statut === 'fait' ? '#00753A' : statut === 'annule' ? '#556' : statut === 'planifie' ? '#0070C0' : '#C0392B' }}>
            {STATUT_LABEL[statut] || statut}
          </span>
          {c.po && <span style={{ color: '#8892A4' }}>· PO {c.po}</span>}
          {c.motif && <span style={{ color: '#8892A4' }}>· {c.motif}</span>}
          {c.texte && <span style={{ color: '#8892A4' }}>« {c.texte} »</span>}
          <button style={S.btnLink} onClick={() => { setMotifPour(null); onStatut(null); }}>annuler</button>
        </div>
      )}

      {!statut && !motifPour && (
        <div style={S.statutBar}>
          <button style={S.btnStatut} onClick={() => onStatut('planifie', {})}>📅 Planifié</button>
          <button style={S.btnStatut} onClick={() => setMotifPour('fait')}>✅ Fait</button>
          <button style={S.btnStatut} onClick={() => setMotifPour('blocage')}>⛔ Blocage</button>
          <button style={S.btnStatut} onClick={() => onStatut('annule', {})}>🚫 Annulé</button>
        </div>
      )}

      {/* Une commande bloquée doit pouvoir se clôturer directement (résolue,
          ou définitivement annulée) sans devoir d'abord cliquer "annuler"
          pour repartir à blanc — comme Planifier/Clôturer côté arbitrage SAV. */}
      {statut === 'blocage' && !motifPour && (
        <div style={S.statutBar}>
          <button style={S.btnStatut} onClick={() => setMotifPour('fait')}>✅ Marquer Fait</button>
          <button style={S.btnStatut} onClick={() => onStatut('annule', {})}>🚫 Annulé (abandon)</button>
        </div>
      )}

      {(!statut || statut === 'blocage') && motifPour === 'fait' && (
        <div style={{ ...S.statutBar, flexDirection: 'column', alignItems: 'stretch' }}>
          <input style={S.inputSm} placeholder="PO (référence de clôture)" value={texteLibre}
            onChange={(e) => setTexteLibre(e.target.value)} autoFocus />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button style={S.btnSave} onClick={validerFait} disabled={!texteLibre.trim()}>Enregistrer</button>
            <button style={S.btnLink} onClick={() => { setMotifPour(null); setTexteLibre(''); }}>retour</button>
          </div>
        </div>
      )}

      {!statut && motifPour === 'blocage' && (
        <div style={S.statutBar}>
          {MOTIFS_BLOCAGE.filter((m) => m !== 'Autre').map((m) => (
            <button key={m} style={S.btnMotif} onClick={() => { onStatut('blocage', { motif: m }); setMotifPour(null); }}>{m}</button>
          ))}
          <button style={S.btnMotif} onClick={() => setMotifPour('autre')}>Autre</button>
          <button style={S.btnLink} onClick={() => setMotifPour(null)}>retour</button>
        </div>
      )}

      {!statut && motifPour === 'autre' && (
        <div style={{ ...S.statutBar, flexDirection: 'column', alignItems: 'stretch' }}>
          <textarea style={{ ...S.inputSm, width: '100%', minHeight: 50, resize: 'vertical' }}
            placeholder="Précise le motif du blocage" value={texteLibre}
            onChange={(e) => setTexteLibre(e.target.value)} autoFocus />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button style={S.btnSave} onClick={validerBlocageAutre} disabled={!texteLibre.trim()}>Enregistrer</button>
            <button style={S.btnLink} onClick={() => { setMotifPour('blocage'); setTexteLibre(''); }}>retour</button>
          </div>
        </div>
      )}

      {historique?.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button style={S.btnLink} onClick={() => setVoirHistorique(!voirHistorique)}>
            {voirHistorique ? 'masquer' : `historique (${historique.length})`}
          </button>
          {voirHistorique && (
            <div style={S.historiqueBox}>
              {historique.map((n, i) => (
                <div key={i} style={S.historiqueLigne}>
                  <span style={{ color: '#8892A4' }}>{n.le}</span>{' '}
                  <strong>{STATUT_LABEL[n.statut] || n.statut}</strong>
                  {n.po && <span> · PO {n.po}</span>}
                  {n.motif && <span> · {n.motif}</span>}
                  {n.texte && <span> « {n.texte} »</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WaComposeModal({ teamName, commandes, onClose, onEnvoyer }) {
  const [coches, setCoches] = useState(() => new Set(commandes.map((c) => c.ref)));
  function toggle(ref) {
    setCoches((prev) => { const next = new Set(prev); if (next.has(ref)) next.delete(ref); else next.add(ref); return next; });
  }
  const selectionnees = commandes.filter((c) => coches.has(c.ref));

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={S.h3}>📱 Envoyer à {teamName}</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button style={S.btnGhost} onClick={() => setCoches(new Set(commandes.map((c) => c.ref)))}>Tout cocher</button>
          <button style={S.btnGhost} onClick={() => setCoches(new Set())}>Tout décocher</button>
          <span style={{ fontSize: 12, color: '#8892A4', marginLeft: 'auto', alignSelf: 'center' }}>
            {selectionnees.length}/{commandes.length} sélectionnées
          </span>
        </div>
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          {commandes.map((c) => (
            <label key={c.ref} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 4px', borderBottom: '1px solid #EEF0F4', cursor: 'pointer' }}>
              <input type="checkbox" checked={coches.has(c.ref)} onChange={() => toggle(c.ref)} style={{ marginTop: 3 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#0F1B3D' }}>{c.ref}</div>
                <div style={{ fontSize: 12, color: '#556' }}>{c.adresse}</div>
              </div>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button style={S.btnPrimary} onClick={() => onEnvoyer(selectionnees)} disabled={!selectionnees.length}>
            📱 Envoyer ({selectionnees.length})
          </button>
          <button style={S.btnGhost} onClick={onClose}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

function NaSettings({ teams, onSave, onClose }) {
  const [dTeams, setDTeams] = useState(teams.map((t) => ({ ...t })));
  const [dirty, setDirty] = useState(false);
  const setT = (fn) => { setDirty(true); setDTeams(fn); };

  function handleClose() {
    if (dirty && !confirm('Des modifications non enregistrées seront perdues. Fermer quand même ?')) return;
    onClose();
  }
  function handleSave() {
    onSave(dTeams.filter((t) => t.name.trim()));
  }

  return (
    <div style={S.modalBg} onClick={handleClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18, color: '#0F1B3D' }}>⚙ Réglages NA</h2>
        <div>
          <p style={S.hint}>
            Les 4 équipes NA. Le dispatch auto complète chaque équipe active jusqu'à {CAPACITE_JOUR} commandes en
            cours — dès qu'une commande d'un SRO donné a déjà été affectée (à la main ou par un dispatch précédent)
            à une équipe, les commandes suivantes du même SRO la suivent automatiquement. Pas de correspondance
            SRO à configurer : elle vient du SRO déjà présent dans le fichier Excel et des affectations déjà faites.
          </p>
          {dTeams.map((t, i) => (
            <div key={i} style={S.settingRow}>
              <input style={{ ...S.inputSm, width: 160 }} placeholder="Nom" value={t.name}
                onChange={(e) => setT(dTeams.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input style={{ ...S.inputSm, flex: 1 }} placeholder="N° WhatsApp (212...)" value={t.phone || ''}
                onChange={(e) => setT(dTeams.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))} />
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={t.active !== false}
                  onChange={(e) => setT(dTeams.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} />
                active
              </label>
              <button style={S.btnDel} title="Supprimer" onClick={() => setT(dTeams.filter((_, j) => j !== i))}>🗑</button>
            </div>
          ))}
          <button style={S.btnAdd} onClick={() => setT([...dTeams, { name: '', phone: '', active: true }])}>+ Ajouter une équipe</button>
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #EEF1F6', display: 'flex', justifyContent: 'flex-end' }}>
          <button style={S.btnSave} onClick={handleSave}>💾 Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { maxWidth: 1500, margin: '0 auto', padding: '16px 20px 60px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  brand: { fontSize: 20, fontWeight: 800, color: '#0F1B3D' },
  title: { fontSize: 15, color: '#556' },
  date: { fontSize: 13, color: '#8892A4', textTransform: 'capitalize' },
  dbOn: { fontSize: 12, background: '#EAFAF1', color: '#00753A', padding: '4px 10px', borderRadius: 8 },
  dbOff: { fontSize: 12, background: '#FFF8EC', color: '#B87700', padding: '4px 10px', borderRadius: 8 },
  card: { background: '#fff', borderRadius: 14, padding: 16, marginBottom: 16, boxShadow: '0 1px 3px rgba(15,27,61,.08)' },
  btnPrimary: { background: '#0070C0', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 18px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  btnGhost: { background: '#F5F7FA', color: '#0F1B3D', border: 'none', borderRadius: 8, padding: '8px 12px', fontSize: 12, cursor: 'pointer' },
  btnAdd: { background: '#EAF3FA', color: '#0070C0', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  btnSave: { background: '#00963F', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnDel: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 },
  btnLink: { background: 'none', border: 'none', color: '#0070C0', fontSize: 11, cursor: 'pointer', padding: 0 },
  btnStatut: { background: '#F5F7FA', border: '1px solid #D7DCE5', borderRadius: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  btnMotif: { background: '#FEF2F2', border: '1px solid #F5C6C6', color: '#C0392B', borderRadius: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer' },
  btnWa: { background: '#00963F', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  warn: { fontSize: 12, color: '#B87700', background: '#FFF8EC', padding: '4px 10px', borderRadius: 6 },
  hint: { fontSize: 12, color: '#8892A4', margin: '4px 0 10px' },
  h3: { margin: '0 0 8px', fontSize: 15 },
  statRow: { display: 'flex', gap: 24, marginTop: 12 },
  inputSm: { border: '1px solid #D7DCE5', borderRadius: 8, padding: '7px 10px', fontSize: 13, flex: 1 },
  select: { border: '1px solid #D7DCE5', borderRadius: 8, padding: '6px 8px', fontSize: 12, minWidth: 140 },
  job: { borderRadius: 10, padding: '10px 12px', marginBottom: 8 },
  statutBar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
  historiqueBox: { marginTop: 6, background: '#F5F7FA', borderRadius: 8, padding: 8 },
  historiqueLigne: { fontSize: 11, padding: '2px 0' },
  techGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 },
  techCol: { background: '#fff', borderRadius: 14, padding: 12, boxShadow: '0 1px 3px rgba(15,27,61,.08)' },
  techHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  modalBg: { position: 'fixed', inset: 0, background: 'rgba(15,27,61,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' },
  tabOn: { padding: '8px 16px', fontSize: 13, fontWeight: 700, color: '#fff', background: '#0F1B3D', border: 'none', borderRadius: 8, cursor: 'pointer' },
  tabOff: { padding: '8px 16px', fontSize: 13, fontWeight: 700, color: '#0F1B3D', background: '#F5F7FA', border: 'none', borderRadius: 8, cursor: 'pointer' },
  settingRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 },
};
