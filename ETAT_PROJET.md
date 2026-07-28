# SAV Dispatch — État du projet (passage de relais, 28/07/2026)

## Ce qui existe et fonctionne
- **App déployée** : https://sav-dispatch.vercel.app (projet Vercel `sav-dispatch`, team `coinbeginners-projects`, projectId `prj_IHlX3RD6VUVcndK6SRcO7oitfPa3`)
- **Version en ligne** : v1.0. La **v1.1 est codée dans ce dossier mais PAS encore déployée** (réglages améliorés : chefs d'équipe multiples, chaque technicien rattaché à un chef, boutons Enregistrer, ajout/suppression techniciens et MSAN).
- **GitHub** : code v1.1 poussé sur https://github.com/coinbeginner-dev/sav-dispatch (branche main). **Le repo n'est PAS encore connecté au projet Vercel** → première tâche : connecter (Vercel → Settings → Git) pour avoir l'auto-déploiement, puis vérifier que la v1.1 part en prod.
- **Auth** : email+pass maison (jose JWT, middleware). Env Vercel : `AUTH_SECRET` (déjà posée), `APP_USERS` = [{"email","pass"}] — comptes actuels : soufiane.elourouba@gmail.com et elkarantiissamdine@gmail.com, mot de passe temporaire `Sav2026!` à changer.

## Fonctionnel (v1.1)
- Upload du fichier matinal .ods/.xlsx (feuille SAV_MT auto-détectée), parsing tolérant (lib/dispatch.js)
- Distribution auto par MSAN → technicien (mapping dans Réglages → Zones, seedé depuis ZONE FTTH.ods)
- Groupes splitter : tickets "SPLT xxx ISOLE" fusionnés en 1 intervention
- Classification retard : Délai(j) → 🔴 ≥2j / 🟠 1-2j / 🟢 <1j + badge HD (hors délai IAM) / DD
- Badge "reporté ×N" via historique localStorage (15 jours)
- Réaffectation par menu déroulant, barres de charge
- WhatsApp via liens wa.me pré-remplis (bouton par technicien + récap par chef d'équipe), découpage auto des messages longs

## Limites connues / prochaines étapes voulues par Soufiane
1. **Connecter GitHub↔Vercel** (auto-deploy) — le user a un token GitHub classique et un token Vercel valides à demander.
2. **Vraie base de données** (Neon Postgres via Vercel, gratuit) pour remplacer localStorage :
   techniciens/zones/chefs partagés multi-appareils, historique tickets centralisé,
   déduplication par n° de ticket entre les uploads quotidiens, suivi des statuts jour après jour.
3. **V2 WhatsApp** : passer des liens wa.me à l'API WhatsApp Business Cloud (envoi 1-clic).
4. Étendre au-delà de SAV_MT : feuille SAV_DFO (dégroupage), puis NA. Pilote = Haddaouia, cible = autres secteurs.

## Données de référence (dans le dossier parent "Projet SAV IAM")
- `SAV FTTH 3GCOM (1).ods` : exemple du fichier reçu chaque matin (feuilles SAV_MT 112 tickets, SAV_DFO)
- `ZONE FTTH.ods` : mapping SR → MSAN → agent (14 MSAN, 7 agents)
- Logique métier : MSAN ⊃ SR ⊃ PCO. Distribution par MSAN.
- TRANCHE : HD = Hors Délai, DD = Dans le Délai
- Réalisation = Clôturé + Qualification NOK (NOK est un traitement effectué)

## Sécurité
- Ne jamais committer de secrets (le .gitignore exclut .env*, DEPLOYER.bat, REDEPLOYER.bat qui contiennent des tokens)
- Les .bat de ce dossier contiennent un token Vercel → à supprimer une fois l'auto-deploy en place
- Demander les tokens (GitHub, Vercel) directement à Soufiane
