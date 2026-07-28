# SAV Dispatch — État du projet (28/07/2026, v1.3)

## Ce qui existe et fonctionne
- **App déployée** : https://sav-dispatch.vercel.app (projet Vercel `sav-dispatch`, team `coinbeginners-projects`, projectId `prj_IHlX3RD6VUVcndK6SRcO7oitfPa3`)
- **Version en ligne** : **v1.3** (couche base + suivi intra-journée). Prod = `main` sur GitHub.
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

## Infrastructure en place (28/07/2026)
- **Base Neon provisionnée** : ressource `sav-dispatch-db` (marketplace Vercel, plan gratuit).
  `DATABASE_URL` posée sur production / preview / development → l'app est en 🟢 **base connectée**.
  Schéma créé et réglages par défaut seedés (7 techniciens, 14 MSAN, 1 chef). Vérifié en conditions
  réelles : upload, déduplication, compteur de jours, clôture — conformes.
- **Auto-déploiement actif** : le projet Vercel est relié à `coinbeginner-dev/sav-dispatch`,
  branche de production `main`. **Chaque `git push` déploie automatiquement.** Plus besoin des .bat.
  *(Le blocage venait de l'app GitHub Vercel qui n'avait accès qu'au dépôt HostReady-Audit ;
  `sav-dispatch` a été ajouté à sa liste d'accès.)*

## Suivi intra-journée (v1.3, en ligne)
Statut par intervention et par jour, stocké dans `ticket_days` : `statut` (`fait` / `pas_acces` /
`reporte`, null = en attente), `motif`, `statut_at`, `source`. La colonne `source` distingue une
saisie chef d'une remontée WhatsApp — c'est le point d'entrée du bot à venir.

- 3 boutons par intervention + liste de motifs, barre d'avancement par technicien,
  compteurs « traités aujourd'hui » et « rouges sans nouvelle ».
- File locale : un statut posé hors ligne repart tout seul au retour du réseau.
- `getEcarts(jour)` : tickets déclarés faits la veille mais **toujours présents** dans le fichier du
  matin = intervention réalisée non clôturée/qualifiée côté IAM. C'est du hors-délai payé pour du
  travail déjà fait. *(Calculé, pas encore affiché dans l'UI — à brancher.)*

## Décision WhatsApp (28/07/2026)
**Direction retenue : WhatsApp Business Cloud API**, pour la remontée terrain par les techniciens.
Raison décisive : ils peuvent envoyer **texte, photo et vocal en darija**, sans rien installer —
ils utilisent déjà l'app IAM et ne veulent pas d'une couche de plus.

- Les boutons/listes interactives WhatsApp ne passent pas à l'échelle (3 boutons, 10 lignes max)
  pour 30 tickets/technicien. **La bonne approche est le message libre + extraction par IA** contre
  la liste des tickets déjà attribués au technicien (ensemble candidat court → robuste même avec une
  transcription darija approximative). Le bot renvoie systématiquement ce qu'il a compris pour
  confirmation, afin de ne jamais marquer « fait » à tort un ticket qui court vers la pénalité.
- Le premier message de la journée doit passer par un **modèle pré-approuvé** (règle des 24 h) ;
  la liste détaillée part ensuite en format libre, gratuitement.
- **Phase de test : aucune SIM ni vérification nécessaire.** Meta fournit un numéro d'essai gratuit
  et jusqu'à 5 destinataires enregistrés. Webhook prévu sur `sav-dispatch.vercel.app/api/whatsapp`.
- App de test à créer sous le portefeuille **Neoclos Maroc** (inutilisé, donc sans risque).
  Ne pas réutiliser l'app `bnbimmo chat` : la vérification d'entreprise se fait au niveau du
  portefeuille, et il ne faut pas rattacher du trafic contenant des données d'abonnés IAM à
  l'activité location courte durée.
- **Point de non-retour** = enregistrement du vrai numéro + vérification d'entreprise + approbation
  des modèles. Avant ça, tout est jetable et l'entité porteuse peut encore changer.
- Risque principal, non technique : les messages partiront d'un numéro professionnel inconnu et non
  plus du WhatsApp d'Issam. Démarrer avec 1-2 techniciens volontaires, pas les 7 d'un coup.

## Prochaines étapes (ordre recommandé)
1. **Bot WhatsApp** — dès que l'app de test Meta existe : webhook `/api/whatsapp`, extraction des
   statuts depuis texte/vocal/photo, boucle de confirmation, écriture avec `source = 'whatsapp'`.
   Le socle de statuts est déjà en place, il n'y a que le canal à brancher.
2. **Afficher les écarts** `getEcarts` dans l'UI (tickets faits mais non clôturés côté IAM).
3. **Feuille SAV_DFO** (dégroupage) : parser et UI déjà en place, seul le mapping de colonnes change.
4. **Multi-secteur (Anfa)** : colonne `secteur` sur `zones` et `techs` + filtre en tête d'écran.

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
