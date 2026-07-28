// ─────────────────────────────────────────────────────────────
// SAV Dispatch — logique métier : parsing, normalisation,
// distribution par MSAN, groupes splitter, classification retard
// ─────────────────────────────────────────────────────────────

// Zones par défaut (issues du fichier ZONE FTTH)
export const DEFAULT_ZONES = [
  { msan: 'GA-C-HADDAOUIA-2:1', tech: 'RAFIK' },
  { msan: 'GA-C-COLLINE-1', tech: 'RAFIK' },
  { msan: 'MZIn-Casa-Crete', tech: 'RAFIK' },
  { msan: 'MZIC-Mandarona5-2', tech: 'RAFIK2' },
  { msan: 'MNOC-JNANECALIFORNIE', tech: 'RAFIK2' },
  { msan: 'MNOC-TAOUZAR', tech: 'RACHID' },
  { msan: 'MZOU-CA-DOUARLMKANSA', tech: 'RACHID' },
  { msan: 'MZOU-CA-HA-RACHIDIA', tech: 'RACHID' },
  { msan: 'MZOu-Casa-AmericanSchool', tech: 'RACHID' },
  { msan: 'MZIC-Fadl2-3', tech: 'RACHID 2' },
  { msan: 'MNOC-VIOLETHADDAOUIA', tech: 'HAMID' },
  { msan: 'MZIn-Ca-Sefrou1-3', tech: 'HAMID' },
  { msan: 'MNOC-HAEDDAMANE', tech: 'HAMID 2' },
  { msan: 'MZIC-Inara4-1', tech: 'YASSINE' },
];

export const DEFAULT_TECHS = [
  { name: 'RAFIK', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'RAFIK2', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'RACHID', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'RACHID 2', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'HAMID', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'HAMID 2', phone: '', active: true, chef: 'Chef équipe' },
  { name: 'YASSINE', phone: '', active: true, chef: 'Chef équipe' },
];

export const DEFAULT_CHEFS = [{ name: 'Chef équipe', phone: '' }];

// Normalise un nom de MSAN pour le matching :
// trim, retire ':' final, espaces multiples, casse
export function normMsan(m) {
  return String(m || '')
    .trim()
    .replace(/:+\s*$/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

// Trouve l'index d'une colonne par fragments de nom (tolérant)
function findCol(headers, ...fragments) {
  const H = headers.map((h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim());
  for (const frag of fragments) {
    const i = H.findIndex((h) => h.includes(frag));
    if (i !== -1) return i;
  }
  return -1;
}

// Parse la feuille SAV_MT (tableau de tableaux, 1ère ligne = headers)
export function parseTickets(rows) {
  if (!rows || rows.length < 2) return { tickets: [], errors: ['Feuille vide'] };
  const headers = rows[0];
  const col = {
    ref: findCol(headers, 'réclam', 'reclam'),
    nd: findCol(headers, 'nd'),
    client: findCol(headers, 'client'),
    msan: findCol(headers, 'msan', 'olt'),
    enreg: findCol(headers, 'enreg'),
    delai: findCol(headers, 'délai', 'delai'),
    famille: findCol(headers, 'famille'),
    contact: findCol(headers, 'contact'),
    adresse: findCol(headers, 'adresse'),
    avancement: findCol(headers, 'avancement'),
    tranche: findCol(headers, 'tranche'),
  };
  const errors = [];
  if (col.ref === -1) errors.push("Colonne 'N° Réclam.' introuvable");
  if (col.msan === -1) errors.push("Colonne 'OLT/MSAN' introuvable");
  if (errors.length) return { tickets: [], errors };

  const tickets = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[col.ref]) continue;
    const ref = String(r[col.ref]).trim();
    if (!/^R\d+/.test(ref)) continue;

    const delaiRaw = col.delai !== -1 ? r[col.delai] : null;
    const delai = typeof delaiRaw === 'number' ? delaiRaw : parseFloat(String(delaiRaw || '').replace(',', '.')) || 0;

    const avancement = col.avancement !== -1 ? String(r[col.avancement] || '').trim() : '';
    // Groupe splitter : "SPLT TAOUZAR:1-1-14-8 ISOLE" → clé
    let splitter = null;
    if (/ISOL/i.test(avancement)) {
      splitter = avancement.replace(/ISOLE?\s*$/i, '').replace(/^SPLITTER\s+|^SPLT\s+/i, '').trim();
    }

    tickets.push({
      ref,
      nd: col.nd !== -1 ? String(r[col.nd] || '').trim() : '',
      client: col.client !== -1 ? String(r[col.client] || '').trim() : '',
      msan: col.msan !== -1 ? String(r[col.msan] || '').trim() : '',
      msanKey: normMsan(col.msan !== -1 ? r[col.msan] : ''),
      enreg: col.enreg !== -1 ? formatDate(r[col.enreg]) : '',
      delai,
      famille: col.famille !== -1 ? String(r[col.famille] || '').trim() : '',
      contact: col.contact !== -1 ? String(r[col.contact] || '').trim() : '',
      adresse: col.adresse !== -1 ? cleanAddr(r[col.adresse]) : '',
      avancement,
      tranche: col.tranche !== -1 ? String(r[col.tranche] || '').trim().toUpperCase() : '',
      splitter,
    });
  }
  // Doublons
  const seen = new Set();
  const uniq = [];
  let dups = 0;
  for (const t of tickets) {
    if (seen.has(t.ref)) { dups++; continue; }
    seen.add(t.ref);
    uniq.push(t);
  }
  if (dups) errors.push(`${dups} doublon(s) supprimé(s)`);
  return { tickets: uniq, errors };
}

function formatDate(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  // Numéro série Excel/ODS
  if (typeof v === 'number' && v > 40000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return String(v).trim();
}

function cleanAddr(a) {
  return String(a || '')
    .replace(/^Province\s+/i, '')
    .replace(/CASA AIN CHOK HAY HASSANI\s*,?\s*/i, '')
    .replace(/CASABLANCA AIN CHOK\s*,?\s*/i, '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');
}

// Classification retard (Délai en jours)
// >= 2j : rouge (zone pénalité SLA 48h) · 1-2j : orange · < 1j : vert
export function retardClass(delai) {
  if (delai >= 2) return { key: 'rouge', label: `J+${delai.toFixed(1)} · SLA dépassé`, color: '#C0392B', bg: '#FEF2F2' };
  if (delai >= 1) return { key: 'orange', label: `J+${delai.toFixed(1)} · 24-48h`, color: '#B87700', bg: '#FFF8EC' };
  return { key: 'vert', label: `J+${delai.toFixed(1)} · < 24h`, color: '#00753A', bg: '#EAFAF1' };
}

// Distribution : msanKey → équipe (zones), sinon null
export function suggestAssignments(tickets, zones, techs) {
  const zoneMap = {};
  for (const z of zones) zoneMap[normMsan(z.msan)] = z.tech;
  const activeNames = new Set(techs.filter((t) => t.active).map((t) => t.name));

  const assignments = {};
  for (const t of tickets) {
    const tech = zoneMap[t.msanKey];
    assignments[t.ref] = tech && activeNames.has(tech) ? tech : null;
  }
  return assignments;
}

// Groupes pour affichage : splitters fusionnés en jobs
// Retourne [{type:'splitter', key, tickets:[...]}, {type:'ticket', tickets:[t]}]
export function buildJobs(tickets) {
  const bySplitter = {};
  const singles = [];
  for (const t of tickets) {
    if (t.splitter) {
      (bySplitter[t.splitter] = bySplitter[t.splitter] || []).push(t);
    } else {
      singles.push(t);
    }
  }
  const jobs = [];
  for (const [key, ts] of Object.entries(bySplitter)) {
    if (ts.length > 1) jobs.push({ type: 'splitter', key, tickets: ts.sort((a, b) => b.delai - a.delai) });
    else singles.push(ts[0]);
  }
  for (const t of singles) jobs.push({ type: 'ticket', key: t.ref, tickets: [t] });
  // Tri : retard max décroissant
  jobs.sort((a, b) => Math.max(...b.tickets.map((t) => t.delai)) - Math.max(...a.tickets.map((t) => t.delai)));
  return jobs;
}

// ── Messages WhatsApp ────────────────────────────────────────
function badge(delai, tranche) {
  const emo = delai >= 2 ? '🔴' : delai >= 1 ? '🟠' : '🟢';
  return `${emo} J+${delai.toFixed(1)}${tranche === 'HD' ? ' ⚠HD' : ''}`;
}

export function buildTechMessage(techName, jobs, dateStr) {
  const lines = [`🔧 *SAV 3GCOM — ${dateStr}*`, `Équipe : *${techName}*`, ''];
  let n = 0;
  const totalTickets = jobs.reduce((s, j) => s + j.tickets.length, 0);
  lines.push(`${jobs.length} intervention(s) · ${totalTickets} ticket(s)`, '');
  for (const job of jobs) {
    n++;
    if (job.type === 'splitter') {
      const worst = Math.max(...job.tickets.map((t) => t.delai));
      lines.push(`*${n}. ⚡ SPLITTER ${job.key}* (${job.tickets.length} clients) ${badge(worst, '')}`);
      for (const t of job.tickets) {
        lines.push(`   • ${t.ref} — ${t.client} 📞${t.contact}`);
      }
      const a = job.tickets[0];
      if (a.adresse) lines.push(`   📍 ${a.adresse}`);
    } else {
      const t = job.tickets[0];
      lines.push(`*${n}. ${t.ref}* ${badge(t.delai, t.tranche)}`);
      lines.push(`   ${t.client} 📞${t.contact}`);
      if (t.famille) lines.push(`   🔧 ${t.famille}`);
      if (t.adresse) lines.push(`   📍 ${t.adresse}`);
    }
    lines.push('');
  }
  lines.push('_Merci de mettre à jour chaque ticket après intervention._');
  return lines.join('\n');
}

export function buildChefMessage(perTech, dateStr, unassignedCount, chefName) {
  const lines = [`📋 *SAV 3GCOM — Récap distribution ${dateStr}*${chefName ? `\nChef d'équipe : *${chefName}*` : ''}`, ''];
  let total = 0;
  for (const [tech, jobs] of Object.entries(perTech)) {
    const nt = jobs.reduce((s, j) => s + j.tickets.length, 0);
    total += nt;
    const rouges = jobs.reduce((s, j) => s + j.tickets.filter((t) => t.delai >= 2).length, 0);
    lines.push(`*${tech}* : ${nt} tickets (${jobs.length} interventions)${rouges ? ` · 🔴${rouges}` : ''}`);
    for (const job of jobs) {
      if (job.type === 'splitter') {
        lines.push(`  ⚡ ${job.key} (${job.tickets.length}) : ${job.tickets.map((t) => t.ref).join(', ')}`);
      } else {
        const t = job.tickets[0];
        lines.push(`  • ${t.ref} ${t.delai >= 2 ? '🔴' : t.delai >= 1 ? '🟠' : '🟢'} ${t.client}`);
      }
    }
    lines.push('');
  }
  lines.push(`*Total distribué : ${total} tickets*`);
  if (unassignedCount) lines.push(`⚠ ${unassignedCount} ticket(s) non affecté(s) — à traiter manuellement`);
  return lines.join('\n');
}

// Découpe un message en parties < maxLen (WhatsApp/URL limite)
export function splitMessage(msg, maxLen = 1800) {
  if (msg.length <= maxLen) return [msg];
  const parts = [];
  const lines = msg.split('\n');
  let cur = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > maxLen && cur.length) {
      parts.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) parts.push(cur.join('\n'));
  return parts.map((p, i) => (parts.length > 1 ? `(${i + 1}/${parts.length})\n${p}` : p));
}

export function waLink(phone, text) {
  const p = String(phone || '').replace(/[^\d]/g, '');
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
