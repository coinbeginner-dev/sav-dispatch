'use client';
import { useState } from 'react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      });
      const d = await r.json();
      if (d.ok) window.location.href = '/';
      else setErr(d.error || 'Identifiants invalides.');
    } catch {
      setErr('Erreur réseau. Réessaie.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={S.wrap}>
      <form onSubmit={submit} style={S.card}>
        <div style={S.brandBar}>3GCOM · SAV FTTH</div>
        <h1 style={S.h1}>SAV Dispatch — Haddaouia</h1>
        <p style={S.sub}>Distribution quotidienne des tickets — accès réservé.</p>

        <label style={S.label}>Adresse email</label>
        <input style={S.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />

        <label style={S.label}>Mot de passe</label>
        <input style={S.input} type="password" value={pass} onChange={(e) => setPass(e.target.value)} required />

        {err && <div style={S.err}>{err}</div>}

        <button style={S.btn} disabled={loading}>
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}

const S = {
  wrap: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, #0F1B3D 0%, #1C2E50 100%)', padding: 16,
  },
  card: {
    background: '#fff', borderRadius: 14, padding: '36px 32px', width: '100%', maxWidth: 400,
    boxShadow: '0 20px 60px rgba(0,0,0,.35)',
  },
  brandBar: {
    display: 'inline-block', background: '#0F1B3D', color: '#E8841A', fontWeight: 700,
    fontSize: 12, letterSpacing: 2, padding: '6px 12px', borderRadius: 6, marginBottom: 16,
  },
  h1: { margin: '0 0 6px', fontSize: 24, color: '#0F1B3D' },
  sub: { margin: '0 0 24px', fontSize: 13, color: '#8892A4' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 6 },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14,
    border: '1px solid #D7DCE5', borderRadius: 8, marginBottom: 16, outline: 'none',
  },
  err: { background: '#FEF2F2', color: '#C0392B', fontSize: 13, padding: '8px 12px', borderRadius: 8, marginBottom: 14 },
  btn: {
    width: '100%', padding: '12px', fontSize: 15, fontWeight: 700, color: '#fff',
    background: '#E8841A', border: 'none', borderRadius: 8, cursor: 'pointer',
  },
};
