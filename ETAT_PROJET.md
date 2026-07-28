# SAV Dispatch — État du projet (28/07/2026, v1.2)

## Ce qui existe et fonctionne
- **App déployée** : https://sav-dispatch.vercel.app (projet Vercel `sav-dispatch`, team `coinbeginners-projects`, projectId `prj_IHlX3RD6VUVcndK6SRcO7oitfPa3`)
- **Version en ligne** : **v1.2** (v1.1 + couche base de données). Prod = `main` sur GitHub.
- **GitHub** : https://github.com/coinbeginner-dev/sav-dispatch (branche `main`, à jour).
- **Auth** : email+pass maison (jose JWT, middleware). Env Vercel : `AUTH_SECRET`, `APP_USERS`
  = [{"email","pass"}] — comptes soufiane.elourouba@gmail.com et elkarantiissamdine@gmail.com,
  mot de passe temporaire `Sav2026!` **à changer**.

## Fonctionnel
- Upload du fichier matinal .ods/.xlsx (feuille SAV_MT auto-détectée), parsing tolérant (`lib/dispatch.js`)
- Distribution auto par MSAN → technicien (Réglages → Zones, seedé depuis ZONE FTTH.ods)
- Groupes splitter : tickets "SPLT xxx ISOLE" fusionnés en 1 intervention
- Classification retard : Délai(j) → 🔴 ≥2j / 🟠 1-2j / 🟢 <1j + badge HD / DD
- Badge "reporté ×N", réaffectation par menu déroulant, barres de charge
- WhatsApp via liens wa.me pré-remplis (par technicien + récap par chef d'équipe), découpage des messages longs
- **Vérifié sur le fichier réel** : 112 tickets → 97 interventions, 0 non affecté, splitters fusionnés.

## Couche base de données (v1.2)
Le code est **entièrement en place et testé**, il s'active **automatiquement** dès que la variable
`DATABASE_URL` existe sur Vercel. Sans elle, l'app retombe sur le localStorage (mode mono-appareil),
ce qui est l'état actuel en prod. Un badge dans l'en-tête indique le mode : 🟢 base / 🟡 local.

- `lib/db.js` — schéma + requêtes. Tables : `techs`, `zones`, `chefs`, `tickets`, `ticket_days`.
- `lib/store.js` — bascule base ↔ localStorage côté client.
- API : `GET/PUT /api/settings`, `GET/POST/PATCH /api/tickets`, `GET /api/history`.
- Ce que la base apporte :
  - techniciens / zones / chefs **partagés entre tous les appareils**
  - **déduplication par n° de ticket** entre les uploads quotidiens
  - compteur `days_seen` = nombre de jours où le ticket est réapparu (badge "reporté ×N", sans limite de 15 jours)
  - **clôture automatique** des tickets absents du fichier du jour (= traités) avec date de clôture
  - **réaffectation manuelle mémorisée** : l'upload du lendemain ne l'écrase pas
  - panneau **Historique** : volumétrie jour par jour (tickets, 🔴 ≥48h, HD, traités) + liste des tickets qui traînent
- Tests : `npm run test:db` exécute le vrai SQL sur un Postgres embarqué (PGlite). 8 groupes de
  vérifications (seed, réglages, dépôt, dédup, clôture, override manuel, technicien désactivé,
  historique, fichier vide, réouverture). **Tous verts.**

## Ce qui reste à faire — 2 actions à faire dans le navigateur
Les deux nécessitent une acceptation de conditions / une autorisation OAuth, impossible en ligne de commande :

1. **Base Neon** — ouvrir https://vercel.com/coinbeginners-projects/~/integrations/accept-terms/neon?source=cli
   et accepter, puis Claude relance `vercel integration add neon` : `DATABASE_URL` est injectée
   automatiquement et l'app passe en 🟢 base connectée au déploiement suivant.
2. **Auto-déploiement GitHub → Vercel** — installer l'app Vercel sur GitHub (https://github.com/apps/vercel)
   pour le compte `coinbeginner-dev` en donnant accès au repo `sav-dispatch`, puis Vercel →
   projet sav-dispatch → Settings → Git → Connect. Ensuite chaque `git push` déploie tout seul.

## Prochaines étapes voulues
3. **V2 WhatsApp** : passer des liens wa.me à l'API WhatsApp Business Cloud (envoi 1-clic).
4. Étendre au-delà de SAV_MT : feuille **SAV_DFO** (dégroupage), puis NA. Pilote = Haddaouia, cible = autres secteurs.

## Données de référence (dossier parent "Projet SAV IAM")
- `App SAV FTTH/SAV FTTH 3GCOM (1).ods` : exemple du fichier reçu chaque matin (SAV_MT 112 tickets, SAV_DFO)
- `App SAV FTTH/ZONE FTTH.ods` : mapping SR → MSAN → agent (14 MSAN, 7 agents)
- Logique métier : MSAN ⊃ SR ⊃ PCO. Distribution par MSAN.
- TRANCHE : HD = Hors Délai, DD = Dans le Délai
- Réalisation = Clôturé + Qualification NOK (NOK est un traitement effectué)

## Sécurité
- Ne jamais committer de secrets (`.gitignore` exclut `.env*`, `DEPLOYER.bat`, `REDEPLOYER.bat`).
- ⚠️ `DEPLOYER.bat` / `REDEPLOYER.bat` contiennent le **token Vercel en clair** → à supprimer une fois
  l'auto-deploy en place, et **penser à révoquer/régénérer ce token** (vercel.com → Settings → Tokens).
- Mot de passe applicatif encore en clair dans `APP_USERS` → à faire évoluer (hash) si l'app s'ouvre à plus de monde.
