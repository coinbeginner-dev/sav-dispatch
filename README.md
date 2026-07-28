# SAV Dispatch — 3GCOM Haddaouia

Distribution quotidienne des tickets SAV par technicien, avec envoi WhatsApp.

## Fonctionnement
1. Se connecter (mêmes comptes que le cockpit : variable APP_USERS)
2. Charger le fichier du matin (.ods ou .xlsx) — la feuille SAV_MT est détectée automatiquement
3. La distribution est proposée : MSAN → technicien (Réglages → Zones)
   - Tickets liés à un même splitter isolé = 1 seule intervention
   - Tri par retard décroissant · badges 🔴 ≥48h / 🟠 24-48h / 🟢 <24h · HD = hors délai IAM
   - Tickets déjà vus les jours précédents = badge « reporté ×N »
4. Ajuster si besoin (menu déroulant sur chaque ticket/intervention)
5. Bouton WhatsApp par technicien → message pré-rempli, il ne reste qu'à envoyer
   Bouton vert = récap complet pour le chef d'équipe

## Réglages (⚙)
- Techniciens : nom + n° WhatsApp (format 2126...) + actif/inactif
- Zones : mapping MSAN → technicien (pré-rempli depuis ZONE FTTH)
- Chef d'équipe : nom + n° WhatsApp

Les réglages sont stockés dans le navigateur (localStorage).

## Déploiement Vercel
```
cd sav-dispatch
npm install
npx vercel@latest deploy --prod --yes
```
Variables d'environnement à configurer sur Vercel (identiques au cockpit) :
- AUTH_SECRET : secret JWT
- APP_USERS : [{"email":"...","pass":"..."}]
