'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ZONES, DEFAULT_TECHS, DEFAULT_CHEFS,
  parseTickets, suggestAssignments, buildJobs, retardClass,
  buildTechMessage, buildChefMessage, splitMessage, waLink,
} from '../lib/dispatch';

const LS = {
  techs: 'savd_techs_v1',
  zones: 'savd_zones_v1',
  chef: 'savd_chef_v1',       // ancien format (un seul chef) — migration
  chefs: 'savd_chefs_v1',     // nouveau format (liste)
  history: 'savd_history_v1',
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export default function Dashboard() {
  const [techs, setTechs] = useState(DEFAULT_TECHS);
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [chefs, setChefs] = useState(DEFAULT_CHEFS);
  const [tickets, setTickets] = useState([]);
  const [assign, setAssign] = useState({});
  const [errors, setErrors] = useState([]);
  const [fileName, setFileName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [reports, setReports] = useState({});
  const [ready, setReady] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    // Migration ancien format chef unique → liste de chefs
    let loadedChefs = load(LS.chefs, null);
    if (!loadedChefs) {
      const oldChef = load(LS.chef, null);
      loadedChefs = oldChef ? [oldChef] : DEFAULT_CHEFS;
    }
    const loadedTechs = load(LS.techs, DEFAULT_TECHS).map((t) => ({
      chef: loadedChefs[0]?.name || '', ...t,
    }));
    setChefs(loadedChefs);
    setTechs(loadedTechs);
    setZones(load(LS.zones, DEFAULT_ZONES));
    setReady(true);
  }, []);

  function persistSettings(newTechs, newZones, newChefs) {
    setTechs(newTechs);
    setZones(newZones);
    setChefs(newChefs);
    save(LS.techs, newTechs);
    save(LS.zones, newZones);
    save(LS.chefs, newChefs);
    if (tickets.length) setAssign(suggestAssignments(tickets, newZones, newTechs));
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
    setTickets(parsed);
    setErrors(errs);
    setAssign(suggestAssignments(parsed, zones, techs));

    const hist = load(LS.history, {});
    const today = new Date().toISOString().slice(0, 10);
    const rep = {};
    for (const t of parsed) {
      let seen = 0;
      for (const [day, refs] of Object.entries(hist)) {
        if (day !== today && refs.includes(t.ref)) seen++;
      }
      if (seen > 0) rep[t.ref] = seen;
    }
    setReports(rep);
    hist[today] = parsed.map((t) => t.ref);
    const days = Object.keys(hist).sort();
    while (days.length > 15) delete hist[days.shift()];
    save(LS.history, hist);
    e.target.value = '';
  }

  // ── Distribution ──────────────────────────────────────────
  const activeTechs = techs.filter((t) => t.active);

  const perTech = useMemo(() => {
    const map = {};
    for (const t of activeTechs) map[t.name] = [];
    const unassigned = [];
    const byTech = {};
    for (const t of tickets) {
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
    return { total, rouge, orange, hd, splitters, reportes: Object.keys(reports).length };
  }, [tickets, reports]);

  function reassignJob(job, newTech) {
    const next = { ...assign };
    for (const t of job.tickets) next[t.ref] = newTech || null;
    setAssign(next);
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
    if (!Object.keys(filled).length) { alert(`Aucun ticket pour les techniciens de ${chef.name}.`); return; }
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={S.date}>{dateStr}</span>
          <button style={S.btnGhost} onClick={() => setShowSettings(true)}>⚙ Réglages</button>
          <a href="/api/logout" style={{ ...S.btnGhost, textDecoration: 'none' }}>Déconnexion</a>
        </div>
      </header>

      {/* Upload */}
      <section style={S.card}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={S.btnPrimary} onClick={() => fileRef.current?.click()}>
            📂 Charger le fichier du jour (.ods / .xlsx)
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
          </div>
        )}
      </section>

      {/* Non affectés */}
      {perTech.unassignedTickets.length > 0 && (
        <section style={{ ...S.card, borderLeft: '4px solid #C0392B' }}>
          <h3 style={{ ...S.h3, color: '#C0392B' }}>⚠ Non affectés ({perTech.unassignedTickets.length}) — MSAN inconnu ou technicien inactif</h3>
          {perTech.unassigned.map((job) => (
            <JobRow key={job.key} job={job} techs={activeTechs} current="" onChange={(v) => reassignJob(job, v)} reports={reports} />
          ))}
        </section>
      )}

      {/* Colonnes techniciens */}
      {tickets.length > 0 && (
        <>
          <section style={S.techGrid}>
            {activeTechs.map((tech) => {
              const jobs = perTech.map[tech.name] || [];
              const nt = jobs.reduce((s, j) => s + j.tickets.length, 0);
              const rouges = jobs.reduce((s, j) => s + j.tickets.filter((t) => t.delai >= 2).length, 0);
              const maxLoad = Math.max(1, ...activeTechs.map((x) => (perTech.map[x.name] || []).reduce((s, j) => s + j.tickets.length, 0)));
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
                  <div style={S.loadBarBg}>
                    <div style={{ ...S.loadBar, width: `${(nt / maxLoad) * 100}%`, background: nt > 15 ? '#C0392B' : '#E8841A' }} />
                  </div>
                  {!tech.phone && nt > 0 && <div style={S.warnSmall}>⚠ numéro WhatsApp manquant</div>}
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    {jobs.map((job) => (
                      <JobRow key={job.key} job={job} techs={activeTechs} current={tech.name} onChange={(v) => reassignJob(job, v)} reports={reports} />
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
              Chaque chef reçoit le récap de ses techniciens. Les boutons ouvrent WhatsApp pré-rempli.
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

function JobRow({ job, techs, current, onChange, reports }) {
  const worst = Math.max(...job.tickets.map((t) => t.delai));
  const rc = retardClass(worst);
  const isSpl = job.type === 'splitter';
  const rep = Math.max(0, ...job.tickets.map((t) => reports[t.ref] || 0));
  return (
    <div style={{ ...S.job, background: rc.bg, borderLeft: `4px solid ${rc.color}` }}>
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
    // Techniciens dont le chef a été supprimé → premier chef restant
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
          <button style={tab === 'techs' ? S.tabOn : S.tabOff} onClick={() => setTab('techs')}>Techniciens</button>
          <button style={tab === 'zones' ? S.tabOn : S.tabOff} onClick={() => setTab('zones')}>Zones (MSAN)</button>
          <button style={tab === 'chefs' ? S.tabOn : S.tabOff} onClick={() => setTab('chefs')}>Chefs d'équipe</button>
        </div>

        {tab === 'techs' && (
          <div>
            <p style={S.hint}>Numéro au format international sans + ni espaces (ex. 212661234567). Chaque technicien est rattaché à un chef d'équipe.</p>
            {dTechs.map((t, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, width: 110 }} placeholder="Nom" value={t.name}
                  onChange={(e) => setT(dTechs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input style={{ ...S.inputSm, flex: 1, minWidth: 120 }} placeholder="N° WhatsApp" value={t.phone}
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
            <button style={S.btnAdd} onClick={() => setT([...dTechs, { name: '', phone: '', active: true, chef: dChefs[0]?.name || '' }])}>
              + Ajouter un technicien
            </button>
          </div>
        )}

        {tab === 'zones' && (
          <div>
            <p style={S.hint}>Chaque MSAN est affecté à un technicien par défaut. Les tickets suivent cette règle, ajustables ensuite.</p>
            {dZones.map((z, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, flex: 1 }} placeholder="Nom du MSAN (ex. MNOC-TAOUZAR)" value={z.msan}
                  onChange={(e) => setZ(dZones.map((x, j) => j === i ? { ...x, msan: e.target.value } : x))} />
                <select style={{ ...S.inputSm, width: 140 }} value={z.tech}
                  onChange={(e) => setZ(dZones.map((x, j) => j === i ? { ...x, tech: e.target.value } : x))}>
                  <option value="">— technicien —</option>
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
            <p style={S.hint}>Chaque chef d'équipe pilote un ensemble de techniciens (rattachement dans l'onglet Techniciens). Il reçoit le récap WhatsApp de ses techniciens uniquement.</p>
            {dChefs.map((c, i) => (
              <div key={i} style={S.settingRow}>
                <input style={{ ...S.inputSm, width: 160 }} placeholder="Nom" value={c.name}
                  onChange={(e) => setC(dChefs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input style={{ ...S.inputSm, flex: 1 }} placeholder="N° WhatsApp (212...)" value={c.phone}
                  onChange={(e) => setC(dChefs.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))} />
                <span style={{ fontSize: 11, color: '#8892A4', minWidth: 80 }}>
                  {dTechs.filter((t) => t.chef === c.name && t.active).length} technicien(s)
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
  settingRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  inputSm: { padding: '8px 10px', fontSize: 13, border: '1px solid #D7DCE5', borderRadius: 8 },
  hint: { fontSize: 12, color: '#8892A4', margin: '0 0 12px' },
};
