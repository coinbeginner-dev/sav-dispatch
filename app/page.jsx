'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ZONES, DEFAULT_TECHS, DEFAULT_CHEFS,
  parseTickets, suggestAssignments, buildJobs, retardClass,
  buildTechMessage, buildChefMessage, splitMessage, waLink,
} from '../lib/dispatch';
import {
  loadInitial, saveSettings, pushUpload, pushAssign, loadHistory,
  pushStatut, flushStatuts, statutsEnAttente, pushPlanifier,
} from '../lib/store';

// Statuts terrain. Aujourd'hui posés par le chef ; demain par la remontée WhatsApp.
const STATUT_LABEL = { fait: '✅ Fait', pas_acces: '🚪 Pas d\'accès', reporte: '⏭ Reporté' };
const MOTIFS = {
  pas_acces: ['Client absent', 'Pas de réponse', 'Refus', 'Adresse introuvable'],
  reporte: ['RDV pris', 'Câble à remplacer', 'Matériel manquant', 'Nacelle / GC requis', 'Autre'],
};

export default function Dashboard() {
  const [techs, setTechs] = useState(DEFAULT_TECHS);
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [chefs, setChefs] = useState(DEFAULT_CHEFS);
  const [tickets, setTickets] = useState([]);
  const [assign, setAssign] = useState({});
  const [errors, setErrors] = useState([]);
  const [fileName, setFileName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reports, setReports] = useState({});
  const [statuts, setStatuts] = useState({});
  const [enAttente, setEnAttente] = useState(0);
  const [db, setDb] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    loadInitial().then((s) => {
      setDb(s.db);
      setTechs(s.techs);
      setZones(s.zones);
      setChefs(s.chefs);
      if (s.tickets.length) {
        setTickets(s.tickets);
        setAssign(s.assign);
        setReports(s.reports);
        setStatuts(s.statuts || {});
        setFileName('dispatch du jour (base)');
      }
    });
  }, []);

  // Statuts posés hors ligne : on repart à la reconnexion
  useEffect(() => {
    const sync = () => flushStatuts().then(() => setEnAttente(statutsEnAttente()));
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, []);

  function marquerStatut(job, statut, motif) {
    const refs = job.tickets.map((t) => t.ref);
    const next = { ...statuts };
    for (const r of refs) {
      if (statut) next[r] = { statut, motif: motif || null, source: 'chef', at: new Date().toISOString() };
      else delete next[r];
    }
    setStatuts(next);
    pushStatut(db, refs, statut, motif).finally(() => setEnAttente(statutsEnAttente()));
  }

  async function persistSettings(newTechs, newZones, newChefs) {
    setTechs(newTechs);
    setZones(newZones);
    setChefs(newChefs);
    if (tickets.length) setAssign(suggestAssignments(tickets, newZones, newTechs));
    try {
      await saveSettings(db, newTechs, newZones, newChefs);
    } catch (e) {
      alert(`Réglages non enregistrés : ${e.message}`);
    }
  }

  const dateStr = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  // ── Upload ────────────────────────────────────────────────
  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const XLSX = await import('xlsx');
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { cellDates: true });
    const sheetName = wb.SheetNames.find((n) => n.toUpperCase().includes('SAV_MT')) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    const { tickets: parsed, errors: errs } = parseTickets(rows);
    e.target.value = '';
    setErrors(errs);
    if (!parsed.length) { setTickets([]); return; }

    setBusy(true);
    try {
      const res = await pushUpload(db, parsed, zones, techs);
      setTickets(res.tickets);
      setAssign(res.assign);
      setReports(res.reports);
      if (res.closed) {
        setErrors([...errs, `${res.closed} ticket(s) absent(s) du fichier → marqué(s) traité(s)`]);
      }
    } catch (err) {
      // La base a échoué : on affiche quand même la distribution du jour
      setTickets(parsed);
      setAssign(suggestAssignments(parsed, zones, techs));
      setErrors([...errs, `Base indisponible (${err.message}) — dispatch affiché sans historique`]);
    } finally {
      setBusy(false);
    }
  }

  // Remet un ticket arbitré dans le dispatch du jour
  function planifierJob(job) {
    const refs = job.tickets.map((t) => t.ref);
    setTickets(tickets.map((t) => (refs.includes(t.ref) ? { ...t, hors_dispatch: false } : t)));
    pushPlanifier(db, refs, true).catch(() => {});
  }

  // ── Distribution ──────────────────────────────────────────
  const activeTechs = techs.filter((t) => t.active);

  // Tickets déjà renseignés un jour précédent : ils reviennent dans le fichier
  // mais ne partent pas aux équipes tant que l'orienteur n'a pas tranché.
  const aArbitrer = useMemo(
    () => buildJobs(tickets.filter((t) => t.hors_dispatch)),
    [tickets],
  );

  const perTech = useMemo(() => {
    const map = {};
    for (const t of activeTechs) map[t.name] = [];
    const unassigned = [];
    const byTech = {};
    for (const t of tickets.filter((x) => !x.hors_dispatch)) {
      const a = assign[t.ref];
      if (a && map[a] !== undefined) (byTech[a] = byTech[a] || []).push(t);
      else unassigned.push(t);
    }
    for (const [tech, ts] of Object.entries(byTech)) map[tech] = buildJobs(ts);
    return { map, unassigned: buildJobs(unassigned), unassignedTickets: unassigned };
  }, [tickets, assign, techs]);

  const stats = useMemo(() => {
    const total = tickets.length;
    const rouge = tickets.filter((t) => t.delai >= 2).length;
    const orange = tickets.filter((t) => t.delai >= 1 && t.delai < 2).length;
    const hd = tickets.filter((t) => t.tranche === 'HD').length;
    const splitters = new Set(tickets.filter((t) => t.splitter).map((t) => t.splitter)).size;
    const faits = tickets.filter((t) => statuts[t.ref]?.statut === 'fait').length;
    const rougesEnAttente = tickets.filter((t) => t.delai >= 2 && !statuts[t.ref]).length;
    return { total, rouge, orange, hd, splitters, faits, rougesEnAttente, reportes: Object.keys(reports).length };
  }, [tickets, reports, statuts]);

  function reassignJob(job, newTech) {
    const next = { ...assign };
    const refs = job.tickets.map((t) => t.ref);
    for (const r of refs) next[r] = newTech || null;
    setAssign(next);
    pushAssign(db, refs, newTech).catch(() => {});
  }

  // ── WhatsApp ──────────────────────────────────────────────
  function sendTech(techName) {
    const tech = techs.find((t) => t.name === techName);
    if (!tech?.phone) { alert(`Pas de numéro WhatsApp pour ${techName}. Ajoute-le dans Réglages.`); return; }
    const jobs = perTech.map[techName] || [];
    if (!jobs.length) { alert(`Aucun ticket pour ${techName}.`); return; }
    const msg = buildTechMessage(techName, jobs, dateStr);
    for (const part of splitMessage(msg)) window.open(waLink(tech.phone, part), '_blank');
  }

  function sendChef(chef) {
    if (!chef.phone) { alert(`Pas de numéro WhatsApp pour ${chef.name}. Ajoute-le dans Réglages.`); return; }
    const filled = {};
    for (const t of activeTechs) {
      if ((t.chef || '') !== chef.name) continue;
      const jobs = perTech.map[t.name] || [];
      if (jobs.length) filled[t.name] = jobs;
    }
    if (!Object.keys(filled).length) { alert(`Aucune intervention pour les équipes de ${chef.name}.`); return; }
    const msg = buildChefMessage(filled, dateStr, perTech.unassignedTickets.length, chef.name);
    for (const part of splitMessage(msg)) window.open(waLink(chef.phone, part), '_blank');
  }

  // ── Rendu ─────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <header style={S.header}>
        <div>
          <span style={S.brand}>3G<span style={{ color: '#E8841A' }}>COM</span></span>
          <span style={S.title}> SAV Dispatch — Haddaouia</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={S.date}>{dateStr}</span>
          <span style={db ? S.dbOn : S.dbOff} title={db
            ? 'Réglages et historique partagés entre tous les appareils'
            : 'Données stockées dans ce navigateur uniquement'}>
            {db ? '🟢 base connectée' : '🟡 mode local'}
          </span>
          {enAttente > 0 && (
            <span style={S.dbOff} title="Statuts enregistrés hors ligne, envoyés au retour du réseau">
              ⏳ {enAttente} statut(s) en attente
            </span>
          )}
          {db && <button style={S.btnGhost} onClick={() => setShowHistory(true)}>📊 Historique</button>}
          <button style={S.btnGhost} onClick={() => setShowSettings(true)}>⚙ Réglages</button>
          <a href="/api/logout" style={{ ...S.btnGhost, textDecoration: 'none' }}>Déconnexion</a>
        </div>
      </header>

      {/* Upload */}
      <section style={S.card}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={S.btnPrimary} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? '⏳ Enregistrement…' : '📂 Charger le fichier du jour (.ods / .xlsx)'}
          </button>
          <input ref={fileRef} type="file" accept=".ods,.xlsx,.xls" style={{ display: 'none' }} onChange={onFile} />
          {fileName && <span style={{ fontSize: 13, color: '#556' }}>{fileName} — {tickets.length} tickets</span>}
          {errors.map((e, i) => <span key={i} style={S.warn}>⚠ {e}</span>)}
        </div>

        {tickets.length > 0 && (
          <div style={S.statRow}>
            <Stat n={stats.total} l="Tickets" c="#0F1B3D" />
            <Stat n={stats.rouge} l="🔴 SLA dépassé (≥48h)" c="#C0392B" />
            <Stat n={stats.orange} l="🟠 24-48h" c="#B87700" />
            <Stat n={stats.hd} l="⚠ HD (hors délai IAM)" c="#C0392B" />
            <Stat n={stats.splitters} l="⚡ Splitters isolés" c="#0070C0" />
            <Stat n={stats.reportes} l="↻ Reportés (déjà vus)" c="#7A1515" />
            {db && <Stat n={stats.faits} l="✅ Traités aujourd'hui" c="#00753A" />}
            {db && <Stat n={stats.rougesEnAttente} l="⏳ Rouges sans nouvelle" c="#C0392B" />}
          </div>
        )}
      </section>

      {/* Arbitrage du matin : tickets déjà renseignés un jour précédent */}
      {aArbitrer.length > 0 && (
        <section style={{ ...S.card, borderLeft: '4px solid #B87700' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ ...S.h3, color: '#B87700', margin: 0 }}>
              ⚖ À arbitrer ({aArbitrer.length}) — déjà renseignés un jour précédent
            </h3>
            <button style={S.btnAdd} onClick={() => aArbitrer.forEach(planifierJob)}>
              Tout planifier
            </button>
          </div>
          <p style={S.hint}>
            Ces tickets sont revenus dans le fichier alors qu'ils avaient déjà un statut.
            Ils sont <strong>exclus du dispatch</strong> et n'apparaissent pas dans les messages WhatsApp
            envoyés aux équipes. Un ticket déjà fait qui réapparaît attend en général une clôture
            côté IAM, pas une nouvelle intervention.
          </p>
          {aArbitrer.map((job) => (
            <ArbitrageRow key={job.key} job={job} techs={activeTechs}
              current={assign[job.tickets[0].ref] || ''}
              onChange={(v) => reassignJob(job, v)}
              onPlanifier={() => planifierJob(job)} />
          ))}
        </section>
      )}

      {/* Non affectés */}
      {perTech.unassignedTickets.length > 0 && (
        <section style={{ ...S.card, borderLeft: '4px solid #C0392B' }}>
          <h3 style={{ ...S.h3, color: '#C0392B' }}>⚠ Non affectés ({perTech.unassignedTickets.length}) — MSAN inconnu ou équipe inactive</h3>
          {perTech.unassigned.map((job) => (
            <JobRow key={job.key} job={job} techs={activeTechs} current="" onChange={(v) => reassignJob(job, v)}
              reports={reports} db={db} statut={statuts[job.tickets[0].ref]}
              onStatut={(s, m) => marquerStatut(job, s, m)} />
          ))}
        </section>
      )}

      {/* Colonnes équipes */}
      {tickets.length > 0 && (
        <>
          <section style={S.techGrid}>
            {activeTechs.map((tech) => {
              const jobs = perTech.map[tech.name] || [];
              const nt = jobs.reduce((s, j) => s + j.tickets.length, 0);
              const rouges = jobs.reduce((s, j) => s + j.tickets.filter((t) => t.delai >= 2).length, 0);
              const maxLoad = Math.max(1, ...activeTechs.map((x) => (perTech.map[x.name] || []).reduce((s, j) => s + j.tickets.length, 0)));
              const traites = jobs.filter((j) => statuts[j.tickets[0].ref]).length;
              return (
                <div key={tech.name} style={S.techCol}>
                  <div style={S.techHead}>
                    <div>
                      <strong>{tech.name}</strong>
                      {tech.chef && <span style={S.chefBadge}>{tech.chef}</span>}
                      <span style={{ fontSize: 12, color: '#8892A4', marginLeft: 8 }}>
                        {nt} tickets · {jobs.length} interv.{rouges ? ` · 🔴${rouges}` : ''}
                      </span>
                    </div>
                    <button style={S.btnWa} onClick={() => sendTech(tech.name)} disabled={!nt}>
                      📱 WhatsApp
                    </button>
                  </div>
                  {db && jobs.length > 0 ? (
                    <>
                      <div style={S.loadBarBg}>
                        <div style={{ ...S.loadBar, width: `${(traites / jobs.length) * 100}%`, background: '#00963F' }} />
                      </div>
                      <div style={{ fontSize: 11, color: '#8892A4', marginBottom: 8 }}>
                        {traites}/{jobs.length} interventions renseignées
                      </div>
                    </>
                  ) : (
                    <div style={S.loadBarBg}>
                      <div style={{ ...S.loadBar, width: `${(nt / maxLoad) * 100}%`, background: nt > 15 ? '#C0392B' : '#E8841A' }} />
                    </div>
                  )}
                  {!tech.phone && nt > 0 && <div style={S.warnSmall}>⚠ numéro WhatsApp manquant</div>}
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    {jobs.map((job) => (
                      <JobRow key={job.key} job={job} techs={activeTechs} current={tech.name}
                        onChange={(v) => reassignJob(job, v)} reports={reports}
                        db={db} statut={statuts[job.tickets[0].ref]}
                        onStatut={(s, m) => marquerStatut(job, s, m)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>

          {/* Envoi récaps chefs */}
          <section style={{ ...S.card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {chefs.map((chef, i) => (
              <button key={i} style={{ ...S.btnPrimary, background: '#00963F' }} onClick={() => sendChef(chef)}>
                📱 Récap → {chef.name}
              </button>
            ))}
            <span style={{ fontSize: 12, color: '#8892A4' }}>
              Chaque chef reçoit le récap de ses équipes. Les boutons ouvrent WhatsApp pré-rempli.
            </span>
          </section>
        </>
      )}

      {tickets.length === 0 && (
        <section style={{ ...S.card, textAlign: 'center', padding: 60, color: '#8892A4' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          Charge le fichier SAV du matin pour obtenir la suggestion de distribution.
          <div style={{ fontSize: 12, marginTop: 8 }}>Feuille attendue : SAV_MT (détection automatique)</div>
        </section>
      )}

      {showSettings && (
        <Settings
          techs={techs} zones={zones} chefs={chefs}
          onSave={(t, z, c) => { persistSettings(t, z, c); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showHistory && <History onClose={() => setShowHistory(false)} />}
    </div>
  );
}

// ── Composants ──────────────────────────────────────────────
function Stat({ n, l, c }) {
  return (
    <div style={S.stat}>
      <div style={{ fontSize: 26, fontWeight: 800, color: c }}>{n}</div>
      <div style={{ fontSize: 11, color: '#8892A4' }}>{l}</div>
    </div>
  );
}

function JobRow({ job, techs, current, onChange, reports, db, statut, onStatut }) {
  const worst = Math.max(...job.tickets.map((t) => t.delai));
  const rc = retardClass(worst);
  const isSpl = job.type === 'splitter';
  const rep = Math.max(0, ...job.tickets.map((t) => reports[t.ref] || 0));
  const [motifPour, setMotifPour] = useState(null);
  const fait = statut?.statut === 'fait';
  return (
    <div style={{
      ...S.job,
      background: statut ? (fait ? '#EAFAF1' : '#F5F7FA') : rc.bg,
      borderLeft: `4px solid ${statut ? (fait ? '#00963F' : '#8892A4') : rc.color}`,
      opacity: statut ? 0.85 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0F1B3D' }}>
            {isSpl ? `⚡ SPLITTER ${job.key} — ${job.tickets.length} clients` : job.tickets[0].ref}
            {job.tickets[0].tranche === 'HD' && !isSpl && <span style={S.hdBadge}>HD</span>}
            {rep > 0 && <span style={S.repBadge}>↻ reporté ×{rep}</span>}
          </div>
          <div style={{ fontSize: 12, color: rc.color, fontWeight: 600 }}>{rc.label}</div>
          {!isSpl && (
            <div style={{ fontSize: 12, color: '#556', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.tickets[0].client} · {job.tickets[0].famille}
            </div>
          )}
          {isSpl && (
            <div style={{ fontSize: 11, color: '#556' }}>
              {job.tickets.map((t) => t.ref).join(' · ')}
            </div>
          )}
        </div>
        <select value={current} onChange={(e) => onChange(e.target.value)} style={S.select}>
          <option value="">— non affecté —</option>
          {techs.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
      </div>

      {db && statut && (
        <div style={S.statutBar}>
          <span style={{ fontWeight: 700, color: fait ? '#00753A' : '#556' }}>
            {STATUT_LABEL[statut.statut]}
          </span>
          {statut.motif && <span style={{ color: '#8892A4' }}>· {statut.motif}</span>}
          {statut.source === 'whatsapp' && <span style={S.waBadge}>via WhatsApp</span>}
          <button style={S.btnLink} onClick={() => { setMotifPour(null); onStatut(null); }}>annuler</button>
        </div>
      )}

      {db && !statut && !motifPour && (
        <div style={S.statutBar}>
          <button style={S.btnStatut} onClick={() => onStatut('fait')}>✅ Fait</button>
          <button style={S.btnStatut} onClick={() => setMotifPour('pas_acces')}>🚪 Pas d'accès</button>
          <button style={S.btnStatut} onClick={() => setMotifPour('reporte')}>⏭ Reporté</button>
        </div>
      )}

      {db && !statut && motifPour && (
        <div style={S.statutBar}>
          {MOTIFS[motifPour].map((m) => (
            <button key={m} style={S.btnMotif} onClick={() => { onStatut(motifPour, m); setMotifPour(null); }}>
              {m}
            </button>
          ))}
          <button style={S.btnLink} onClick={() => setMotifPour(null)}>retour</button>
        </div>
      )}
    </div>
  );
}

// Ticket revenu dans le fichier alors qu'il avait déjà un statut.
// L'orienteur voit ce qui a été déclaré, par qui et quand, choisit l'équipe,
// puis décide de le remettre ou non dans la distribution du jour.
function ArbitrageRow({ job, techs, current, onChange, onPlanifier }) {
  const t = job.tickets[0];
  const LIB = { fait: '✅ déclaré fait', pas_acces: "🚪 pas d'accès", reporte: '⏭ reporté' };
  const jour = t.arbitrage_le ? t.arbitrage_le.split('-').reverse().join('/') : '';
  return (
    <div style={{ ...S.job, background: '#FFF8EC', borderLeft: '4px solid #B87700' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#0F1B3D' }}>
            {job.type === 'splitter' ? `⚡ SPLITTER ${job.key} — ${job.tickets.length} clients` : t.ref}
            {t.days_seen > 1 && <span style={S.repBadge}>↻ {t.days_seen}e jour</span>}
          </div>
          <div style={{ fontSize: 12, color: '#B87700', fontWeight: 600 }}>
            {LIB[t.arbitrage] || t.arbitrage} le {jour}
            {t.arbitrage_motif ? ` · ${t.arbitrage_motif}` : ''}
          </div>
          <div style={{ fontSize: 12, color: '#556' }}>{t.client} · {t.msan}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={current} onChange={(e) => onChange(e.target.value)} style={S.select}>
            <option value="">— équipe —</option>
            {techs.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
          <button style={S.btnSave} onClick={onPlanifier}>Planifier</button>
        </div>
      </div>
    </div>
  );
}

// Réglages avec brouillon local + bouton Enregistrer
function Settings({ techs, zones, chefs, onSave, onClose }) {
  const [tab, setTab] = useState('techs');
  const [dTechs, setDTechs] = useState(techs.map((t) => ({ ...t })));
  const [dZones, setDZones] = useState(zones.map((z) => ({ ...z })));
  const [dChefs, setDChefs] = useState(chefs.map((c) => ({ ...c })));
  const [dirty, setDirty] = useState(false);

  const mark = (fn) => (...args) => { setDirty(true); fn(...args); };
  const setT = mark(setDTechs), setZ = mark(setDZones), setC = mark(setDChefs);

  function handleClose() {
    if (dirty && !confirm('Des modifications non enregistrées seront perdues. Fermer quand même ?')) return;
    onClose();
  }

  function handleSave() {
    const cleanTechs = dTechs.filter((t) => t.name.trim());
    const cleanZones = dZones.filter((z) => z.msan.trim());
    const cleanChefs = dChefs.filter((c) => c.name.trim());
    // Equipes dont le chef a été supprimé → premier chef restant
    const chefNames = new Set(cleanChefs.map((c) => c.name));
    const fixedTechs = cleanTechs.map((t) => chefNames.has(t.chef) ? t : { ...t, chef: cleanChefs[0]?.name || '' });
    onSave(fixedTechs, cleanZones, cleanChefs);
  }

  return (
    <div style={S.modalBg} onClick={handleClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#0F1B3D' }}>Réglages {dirty && <span style={{ fontSize: 12, color: '#B87700' }}>· non enregistré</span>}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btnSave} onClick={handleSave}>💾 Enregistrer</button>
            <button style={{ ...S.btnGhost, color: '#556', background: '#EEF1F6', border: 'none' }} onClick={handleClose}>✕ Fermer</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button style={tab === 'techs' ? S.tabOn : S.tabOff} onClick={() => setTab('techs')}>Équipes</button>
          <button style={tab === 'zones' ? S.tabOn : S.tabOff} onClick={() => setTab('zones')}>Zones (MSAN)</button>
          <button style={tab === 'chefs' ? S.tabOn : S.tabOff} onClick={() => setTab('chefs')}>Chefs d'équipe</button>
        </div>

        {tab === 'techs' && (
          <div>
            <p style={S.hint}>Numéro au format international sans + ni espaces (ex. 212661234567). Chaque équipe est identifiée par le nom de son TL, avec son compte IAM, et rattachée à un chef d'équipe. Le numéro WhatsApp est au format international sans + ni espaces.</p>
            {dTechs.map((t, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, width: 150 }} placeholder="Nom (TL)" value={t.name}
                  onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input style={{ ...S.inputSm, flex: 1, minWidth: 170 }} placeholder="Compte IAM" value={t.compte || ''}
                  onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, compte: e.target.value } : x))} />
                <input style={{ ...S.inputSm, width: 130 }} placeholder="N° WhatsApp" value={t.phone}
                  onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))} />
                <select style={{ ...S.inputSm, width: 130 }} value={t.chef || ''}
                  onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, chef: e.target.value } : x))}>
                  <option value="">— chef ? —</option>
                  {dChefs.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={t.active}
                    onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} />
                  actif
                </label>
                <button style={S.btnDel} title="Supprimer" onClick={() => setT(dTechs.filter((_, j) => j !== i))}>🗑</button>
              </div>
            ))}
            <button style={S.btnAdd} onClick={() => setT([...dTechs, { name: '', compte: '', phone: '', active: true, chef: dChefs[0]?.name || '' }])}>
              + Ajouter une équipe
            </button>
          </div>
        )}

        {tab === 'zones' && (
          <div>
            <p style={S.hint}>Chaque MSAN est affecté à une équipe par défaut. Les tickets suivent cette règle, ajustables ensuite.</p>
            {dZones.map((z, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, flex: 1 }} placeholder="Nom du MSAN (ex. MNOC-TAOUZAR)" value={z.msan}
                  onChange={(e) => setZ(dZones.map((x, j) => j === i ? { ...x, msan: e.target.value } : x))} />
                <select style={{ ...S.inputSm, width: 140 }} value={z.tech}
                  onChange={(e) => setZ(dZones.map((x, j) => j === i ? { ...x, tech: e.target.value } : x))}>
                  <option value="">— équipe —</option>
                  {dTechs.filter((t) => t.name.trim()).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <button style={S.btnDel} title="Supprimer" onClick={() => setZ(dZones.filter((_, j) => j !== i))}>🗑</button>
              </div>
            ))}
            <button style={S.btnAdd} onClick={() => setZ([...dZones, { msan: '', tech: dTechs[0]?.name || '' }])}>
              + Ajouter un MSAN
            </button>
          </div>
        )}

        {tab === 'chefs' && (
          <div>
            <p style={S.hint}>Chaque chef d'équipe pilote plusieurs équipes (rattachement dans l'onglet Équipes). Il reçoit le récap WhatsApp de ses équipes uniquement, et c'est lui qui remonte les statuts.</p>
            {dChefs.map((c, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, width: 160 }} placeholder="Nom" value={c.name}
                  onChange={(e) => setC(dChefs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input style={{ ...S.inputSm, flex: 1 }} placeholder="N° WhatsApp (212...)" value={c.phone}
                  onChange={(e) => setC(dChefs.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))} />
                <span style={{ fontSize: 11, color: '#8892A4', minWidth: 80 }}>
                  {dTechs.filter((t) => t.chef === c.name && t.active).length} équipe(s)
                </span>
                <button style={S.btnDel} title="Supprimer" onClick={() => setC(dChefs.filter((_, j) => j !== i))}>🗑</button>
              </div>
            ))}
            <button style={S.btnAdd} onClick={() => setC([...dChefs, { name: '', phone: '' }])}>
              + Ajouter un chef d'équipe
            </button>
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #EEF1F6', display: 'flex', justifyContent: 'flex-end' }}>
          <button style={S.btnSave} onClick={handleSave}>💾 Enregistrer les changements</button>
        </div>
      </div>
    </div>
  );
}

// Historique centralisé : volumétrie jour par jour + tickets qui traînent
function History({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    loadHistory()
      .then((d) => (d.db ? setData(d) : setErr(d.error || 'Base indisponible')))
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div style={S.modalBg} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#0F1B3D' }}>📊 Historique</h2>
          <button style={{ ...S.btnGhost, color: '#556', background: '#EEF1F6', border: 'none' }} onClick={onClose}>✕ Fermer</button>
        </div>

        {err && <p style={S.warn}>⚠ {err}</p>}
        {!data && !err && <p style={S.hint}>Chargement…</p>}

        {data && (
          <>
            <div style={S.statRow}>
              <Stat n={data.totaux.total} l="Tickets suivis (total)" c="#0F1B3D" />
              <Stat n={data.totaux.ouverts} l="Encore ouverts" c="#C0392B" />
              <Stat n={data.totaux.clos} l="Traités (sortis du fichier)" c="#00753A" />
            </div>

            <h3 style={{ ...S.h3, marginTop: 20 }}>Jour par jour</h3>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Date</th><th style={S.th}>Tickets</th>
                  <th style={S.th}>🔴 ≥48h</th><th style={S.th}>⚠ HD</th><th style={S.th}>✅ Traités</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day}>
                    <td style={S.td}>{d.day.split('-').reverse().join('/')}</td>
                    <td style={S.td}>{d.total}</td>
                    <td style={{ ...S.td, color: '#C0392B', fontWeight: 700 }}>{d.rouge}</td>
                    <td style={S.td}>{d.hd}</td>
                    <td style={{ ...S.td, color: '#00753A' }}>{d.clos}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style={{ ...S.h3, marginTop: 24 }}>
              Tickets reportés — présents sur plusieurs jours ({data.vieux.length})
            </h3>
            {data.vieux.length === 0 && <p style={S.hint}>Aucun ticket ne traîne d'un jour sur l'autre.</p>}
            {data.vieux.length > 0 && (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Ticket</th><th style={S.th}>Client</th><th style={S.th}>MSAN</th>
                    <th style={S.th}>Jours</th><th style={S.th}>Délai</th><th style={S.th}>Équipe</th>
                  </tr>
                </thead>
                <tbody>
                  {data.vieux.map((t) => (
                    <tr key={t.ref}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{t.ref}</td>
                      <td style={S.td}>{t.client}</td>
                      <td style={{ ...S.td, fontSize: 11 }}>{t.msan}</td>
                      <td style={{ ...S.td, color: '#7A1515', fontWeight: 700 }}>↻ {t.days_seen}</td>
                      <td style={S.td}>J+{Number(t.delai).toFixed(1)}</td>
                      <td style={S.td}>{t.assigned_tech || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────
const S = {
  page: { maxWidth: 1500, margin: '0 auto', padding: '16px 20px 60px' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 20px', background: '#0F1B3D', borderRadius: 12, marginBottom: 16, color: '#fff',
  },
  brand: { fontWeight: 800, fontSize: 18 },
  title: { fontSize: 15, marginLeft: 10, color: '#AABBCC' },
  date: { fontSize: 13, color: '#8899BB' },
  card: { background: '#fff', borderRadius: 12, padding: 18, marginBottom: 16, boxShadow: '0 2px 10px rgba(15,27,61,.06)' },
  btnPrimary: {
    padding: '11px 20px', fontSize: 14, fontWeight: 700, color: '#fff',
    background: '#E8841A', border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  btnGhost: {
    padding: '8px 14px', fontSize: 13, color: '#fff', background: 'rgba(255,255,255,.12)',
    border: '1px solid rgba(255,255,255,.25)', borderRadius: 8, cursor: 'pointer',
  },
  btnSave: {
    padding: '9px 18px', fontSize: 13, fontWeight: 700, color: '#fff',
    background: '#00963F', border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  btnAdd: {
    padding: '8px 14px', fontSize: 13, fontWeight: 600, color: '#0F1B3D', background: '#EEF1F6',
    border: '1px dashed #B8C0D0', borderRadius: 8, cursor: 'pointer', marginTop: 4,
  },
  btnWa: {
    padding: '7px 12px', fontSize: 12, fontWeight: 700, color: '#fff',
    background: '#25D366', border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  btnDel: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 },
  warn: { fontSize: 12, color: '#B87700', background: '#FFF8EC', padding: '4px 10px', borderRadius: 6 },
  warnSmall: { fontSize: 11, color: '#C0392B', padding: '4px 0' },
  statRow: { display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' },
  stat: { minWidth: 90 },
  techGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14, marginBottom: 16,
  },
  techCol: { background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 2px 10px rgba(15,27,61,.06)' },
  techHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  chefBadge: {
    marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#0070C0', background: '#EAF3FA',
    padding: '2px 7px', borderRadius: 4, verticalAlign: 'middle',
  },
  loadBarBg: { height: 6, background: '#EEF1F6', borderRadius: 3, marginBottom: 10 },
  loadBar: { height: 6, borderRadius: 3, transition: 'width .3s' },
  job: { borderRadius: 8, padding: '8px 10px', marginBottom: 8 },
  select: { fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid #D7DCE5', maxWidth: 130 },
  hdBadge: {
    marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#fff', background: '#C0392B',
    padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle',
  },
  repBadge: {
    marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#7A1515', background: '#FFDDDD',
    padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle',
  },
  h3: { margin: '0 0 10px', fontSize: 15 },
  modalBg: {
    position: 'fixed', inset: 0, background: 'rgba(15,27,61,.5)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16,
  },
  modal: {
    background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 720,
    maxHeight: '85vh', overflowY: 'auto',
  },
  tabOn: {
    padding: '8px 16px', fontSize: 13, fontWeight: 700, color: '#fff', background: '#0F1B3D',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  tabOff: {
    padding: '8px 16px', fontSize: 13, color: '#556', background: '#EEF1F6',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  },
  dbOn: {
    fontSize: 11, fontWeight: 700, color: '#7CE0A8', background: 'rgba(0,150,63,.22)',
    padding: '4px 10px', borderRadius: 20,
  },
  dbOff: {
    fontSize: 11, fontWeight: 700, color: '#FFD79A', background: 'rgba(232,132,26,.22)',
    padding: '4px 10px', borderRadius: 20,
  },
  statutBar: {
    display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
    marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(15,27,61,.08)', fontSize: 11,
  },
  btnStatut: {
    padding: '6px 10px', fontSize: 11, fontWeight: 600, color: '#0F1B3D', background: '#fff',
    border: '1px solid #D7DCE5', borderRadius: 6, cursor: 'pointer',
  },
  btnMotif: {
    padding: '5px 9px', fontSize: 11, color: '#0F1B3D', background: '#EEF1F6',
    border: 'none', borderRadius: 6, cursor: 'pointer',
  },
  btnLink: {
    padding: 0, fontSize: 11, color: '#8892A4', background: 'none',
    border: 'none', cursor: 'pointer', textDecoration: 'underline', marginLeft: 'auto',
  },
  waBadge: {
    fontSize: 10, fontWeight: 700, color: '#0B6B33', background: '#D7F5E3',
    padding: '2px 6px', borderRadius: 4,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase',
    color: '#8892A4', borderBottom: '1px solid #EEF1F6', whiteSpace: 'nowrap',
  },
  td: { padding: '7px 10px', borderBottom: '1px solid #F5F7FA', color: '#33415C' },
  settingRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  inputSm: { padding: '8px 10px', fontSize: 13, border: '1px solid #D7DCE5', borderRadius: 8 },
  hint: { fontSize: 12, color: '#8892A4', margin: '0 0 12px' },
};
