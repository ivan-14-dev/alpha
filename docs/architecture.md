# Architecture d'Alpha

## Périmètre et choix de départ

Alpha est un **monolithe modulaire local**, conçu pour parcourir réellement la chaîne projet → campagne → candidature → rapport → validation → versement simulé, ainsi que les échanges communautaires et les commandes de marketplace.

- **Interface** : React 19, TypeScript, React Router et Vite ; textes et parcours en français.
- **API** : Express 5, routeurs métier sous `/api`, validation des entrées avec Zod.
- **Persistance** : `node:sqlite`, une base SQLite locale, des clés étrangères, des contraintes et des transactions SQL synchrones.
- **Identité** : comptes locaux et sessions persistantes par cookie ; pas d'OAuth.
- **Finance** : écritures de démonstration uniquement, sans prestataire externe.

```text
Navigateur
  └─ Interface React
       └─ /api, cookie de session et en-tête applicatif
            └─ Express : contrôle d'origine, authentification, autorisation
                 ├─ 13 routeurs métier
                 ├─ helpers partagés : finance, notifications, audit
                 └─ SQLite : une base persistante
```

En développement, Vite écoute sur `127.0.0.1:5173` et relaie `/api` vers Express sur `127.0.0.1:3001`. Après compilation, Express sert `dist` et l'API sur le même port. Les commandes et variables sont détaillées dans le [README](../README.md).

Les pages métier sont chargées à la demande par route, avec un état de chargement et un écran de récupération en cas d'échec. Le tableau de bord reste dans le chargement initial.

Il n'y a pas de microservices, de bus d'événements, de worker, de file de tâches ni de base PostgreSQL dans cette version. Les appels SQLite synchrones et le processus unique sont adaptés à cette première installation locale, pas à une promesse de montée en charge horizontale.

## Treize modules et responsabilité des données

La propriété ci-dessous est **conceptuelle** : elle indique le module responsable du sens métier et du cycle de vie. Elle n'implique ni base séparée ni isolation stricte au niveau du stockage. Les routeurs réalisent des jointures intermodules, et certaines transitions écrivent dans plusieurs domaines au sein d'une même transaction.

| Module / préfixe API | Responsabilité | Données principales |
| --- | --- | --- |
| Projets — `/api/projects` | Catalogue, détail, visibilité et rattachement à une organisation | `projects` |
| Tests — `/api/testing` | Campagnes, sélection, missions et rapports structurés | `campaigns`, `applications`, `missions`, `test_reports` |
| Communautés — `/api/community` | Groupes publics, adhésions, publications et échanges publics | `groups`, `group_members`, `posts`, `post_likes`, `comments` |
| Marketplace — `/api/marketplace` | Offres, droits annoncés, commandes et livraison privée | `listings`, `orders` |
| Paiements — `/api/payments` | Budgets, réservations, versements fictifs et historique personnel | `transactions`, avec les règles partagées de `server/finance.ts` |
| Profils et organisations — `/api/people` | Profils publics, compétences, organisations, invitations et rôles internes | Champs de profil de `users`, `organizations`, `organization_members`, `organization_invitations` |
| Réputation — `/api/reputation` | Éligibilité aux avis, notes et agrégats publics | `reviews` |
| Communication — `/api/communication` | Conversations privées et notifications internes | `conversations`, `conversation_members`, `messages`, `notifications` |
| Confiance — `/api/trust` | Signalements, instruction des litiges et décisions administratives | `moderation_reports`, `audit_events` |
| Intégrations — `/api/integrations` | Liens de projet et export JSON contrôlé | `integrations` ; lecture des campagnes, missions et rapports |
| Réseau — `/api/network` | Abonnements aux personnes et projets publics | `user_follows`, `project_follows` |
| Atelier — `/api/workspace` | Tâches privées, attribution et avancement des équipes | `project_tasks` |
| Découverte — `/api/discovery` | Recherche publique transversale et favoris privés | Lecture des projets, campagnes, offres et profils ; `bookmarks` |

L'authentification est une infrastructure transversale (`/api/auth`) : elle gère les identifiants dans `users` et les sessions dans `sessions`. Le tableau de bord (`/api/dashboard`) agrège les données accessibles ; il n'est pas un domaine de stockage supplémentaire.

Exemples de coopération assumée :

- la sélection d'un testeur consulte le budget, crée une mission, une notification et un événement d'audit ;
- le versement inscrit une transaction puis fait passer la mission à `paid` ;
- l'achat et l'acceptation d'une livraison créent les écritures fictives de marketplace ;
- la modération consulte le contexte d'une ressource signalée et peut faire reprendre une mission ou une commande bloquée ;
- les notifications et l'audit sont écrits par les autres domaines via des helpers partagés.

Cette organisation facilite une évolution progressive ; elle ne garantit pas une extraction immédiate de chaque module en service indépendant.

## Persistance et cohérence

`server/db.ts` ouvre `DATABASE_PATH`, par défaut `./data/alpha.sqlite`, active les clés étrangères, le journal WAL et un délai d'attente de verrou de cinq secondes. Le socle V1 est créé avec des instructions `CREATE ... IF NOT EXISTS`, puis `server/migrations.ts` applique les migrations manquantes sous un verrou transactionnel.

Les modifications liées sont regroupées dans des transactions `BEGIN IMMEDIATE` / `COMMIT`, avec `ROLLBACK` en cas d'erreur. Il ne faut pas placer d'appel réseau ou d'attente asynchrone à l'intérieur de ces transactions synchrones.

Les contraintes complètent les contrôles métier : candidature unique par campagne et testeur, mission unique par candidature, rapport unique par mission, avis unique par auteur et mission, et index uniques sur le versement d'une mission ainsi que les écritures d'achat et de vente d'une commande.

Les montants sont des **entiers en centimes**, pas des nombres flottants. Le champ `transactions.mode` est contraint à `demo`. Le bilan affiché n'est ni un compte bancaire ni un portefeuille utilisable.

Le seed est explicite et facultatif : il ajoute des données fictives uniquement si aucun compte n'existe. Un lancement normal ne crée pas de compte administrateur ni de mot de passe connu.

Depuis la V2, `schema_migrations` conserve la version, le nom, l'empreinte SHA-256 du SQL et la date d'application. La migration `002-network.sql` ajoute les relations sociales, invitations, tâches, le rattachement public des publications à un projet et les notes détaillées facultatives. Elle ne modifie pas les données métier V1. Un second démarrage ne la rejoue pas. Une empreinte incohérente ou une version inconnue bloque explicitement le démarrage ; un échec SQL annule l'ensemble de la migration. Toute évolution suivante doit utiliser une nouvelle migration plutôt que modifier le SQL déjà appliqué. Un retour arrière destructif n'est pas fourni.

La migration `003-professional.sql` ajoute les favoris, le versionnement et l'historique des commandes, ainsi que des identifiants publics de session. Les valeurs existantes, y compris les cookies encore valides, sont conservées. Les dates historiques absentes restent inconnues ; aucune opération financière n'est créée par la migration.

## Cycles de vie

### Projet et collaboration

Un membre crée un projet public ou privé et peut le rattacher à une organisation autorisée. Un projet public est consultable sans compte. Un projet privé est accessible à son propriétaire, aux membres de son organisation et aux testeurs disposant d'une mission non annulée rattachée au projet.

La gestion du projet est réservée à son propriétaire ou aux membres de l'organisation disposant du rôle `owner` ou `admin`. Les rôles d'organisation sont distincts du rôle d'administrateur de plateforme. Les droits de responsable d'une campagne restent attachés à `campaigns.owner_id` : gérer un projet ne donne pas automatiquement toutes les actions financières d'une campagne créée par un autre membre.

L'ajout de membres d'organisation porte sur des comptes existants, par invitation interne et consentement explicite ; aucun email n'est envoyé. Le propriétaire propose le rôle `member` ou `admin`, jamais `owner`. Le destinataire accepte ou décline, et une invitation expire après sept jours. Le propriétaire peut la révoquer. Un membre ordinaire peut quitter l'organisation, mais le propriétaire ne peut pas laisser une équipe sans responsable.

Le parcours V1 d'ajout direct est volontairement restreint : `POST /api/people/organizations/:id/members` refuse de créer un nouveau membre et exige une invitation. Il conserve la modification d'un rôle existant ; le nouveau `PATCH .../members/:userId` est le parcours explicite. Aucun ancien client ne peut contourner le consentement en utilisant l'ancienne route.

Les profils publics ne constituent pas un annuaire des adresses email. Une invitation en attente ne donne ni accès aux membres de l'équipe ni aux projets privés. Le retrait ou le départ d'un membre révoque ses accès d'équipe immédiatement ; ses éventuels droits indépendants de propriétaire de projet ou de testeur restent distincts.

### Réseau et publications de projet

Les abonnements sont des relations uniques en base. Un membre ne peut pas se suivre lui-même ; l'ajout répété d'un abonnement ne crée ni doublon ni nouvelle notification. Le fil personnalisé combine ses propres publications, celles des membres suivis, les actualités des projets suivis et les groupes rejoints, sans modifier la visibilité des contenus.

Une publication peut appartenir à un groupe **ou** à un projet, pas aux deux. Les actualités de projet sont publiques et réservées aux responsables d'un projet public ; ce ne sont pas des notes confidentielles d'équipe. Si le projet devient privé, les publications liées disparaissent de tous les fils, du tableau de bord et des accès directs aux commentaires et réactions, même pour leur auteur. Les abonnements ne donnent pas accès au projet privé. Une notification déjà reçue ne constitue jamais une autorisation d'accès.

### Atelier d'équipe

Le tableau de tâches d'un projet est privé à son propriétaire et aux membres de son organisation, même lorsque sa fiche projet est publique. Un testeur affecté à une campagne ne devient pas automatiquement collaborateur : `canCollaborateProject` est distinct de `canReadProject`.

Les responsables créent, attribuent et organisent les tâches ; un destinataire encore membre de l'équipe peut changer l'état de sa tâche, mais pas ses consignes ou son attribution. Les états sont `todo`, `in_progress` et `done`, avec priorité, échéance facultative et description. Les tâches ne déclenchent aucun paiement et ne remplacent pas les missions du laboratoire.

Chaque tâche possède une `version`. Une modification ou suppression doit présenter la version observée ; une version périmée produit un conflit explicite plutôt qu'une perte silencieuse des modifications d'un autre membre. Les droits et l'éligibilité du destinataire sont vérifiés dans la transaction. Un ancien membre ne conserve pas ses droits sur une tâche du seul fait qu'il y est encore nommé.

### Recherche publique et bibliothèque privée

La recherche V3 réunit les projets publics, leurs campagnes, les offres actives et les profils publics. Elle ne recherche pas dans les emails, messages, rapports, tâches ou livraisons. Les filtres et la pagination s'appliquent côté SQL, avec un ordre stable et des caractères `%`, `_` et `\` traités littéralement dans la saisie.

Les favoris utilisent une clé unique `(user_id,target_type,target_id)` et ne déclenchent aucune notification. Leur liste appartient uniquement à la session courante. Une jointure avec les ressources actuellement visibles filtre à la fois les lignes et les compteurs ; même le propriétaire d'un projet privé ne le retrouve pas par cette surface publique. Les références masquées restent enregistrées et peuvent réapparaître si la ressource redevient publique ; leur suppression par leur propriétaire ne nécessite pas qu'elles soient encore visibles. Un favori n'accorde aucun droit ni réservation.

### Test et versement de démonstration

1. Le responsable crée une campagne avec un projet, des consignes, une récompense, un nombre de places et une échéance.
2. Il finance explicitement un budget fictif, plafonné au budget prévu. Une campagne créée n'est pas financée automatiquement.
3. Un autre membre accessible à la campagne candidate : `pending` → `accepted` ou `rejected`. Une candidature ne constitue pas encore une mission.
4. La sélection exige une campagne ouverte, une échéance non dépassée, une place disponible et un budget disponible suffisant. Elle crée une mission `assigned`.
5. Le testeur commence (`in_progress`) et soumet son rapport (`submitted`). Une soumission directe depuis `assigned` est aussi permise.
6. Le responsable accepte (`accepted`) ou demande des corrections (`changes_requested`). Le testeur corrige réellement le rapport avant de le soumettre à nouveau.
7. Après acceptation, le responsable déclenche séparément le versement simulé : `accepted` → `paid`.

```text
assigned → in_progress → submitted → accepted → paid (démo)
assigned ──────────────→ submitted
submitted → changes_requested → submitted (rapport corrigé)
```

Le rapport est du texte structuré : synthèse, étapes, résultat attendu, résultat observé et URL de preuve facultative. Alpha ne vérifie pas automatiquement la qualité du test ni l'authenticité d'une preuve.

Le budget disponible est calculé ainsi :

```text
financements terminés − versements terminés − récompenses réservées
```

Les missions ni payées ni annulées réservent leur récompense, y compris pendant une correction ou un litige. Un nouveau déclenchement d'un versement déjà effectué retourne l'état payé sans créer une seconde écriture.

Un litige avant paiement fait passer la mission à `disputed` et bloque le versement normal. La modération peut décider d'une reprise compatible avec les données existantes ou d'une annulation. Aucun règlement ni remboursement automatique n'accompagne cette décision.

### Commande de marketplace

Une offre `active` décrit un produit ou service, un prix fictif, des livrables et une licence **non exclusive**. Elle peut être archivée pour arrêter les nouveaux achats. Après la première commande, les conditions de l'offre sont figées ; une autre offre doit être créée pour les changer.

```text
achat simulé → paid → delivered → completed
                        livraison   acceptation acheteur
```

L'achat inscrit une transaction `purchase`. Le vendeur saisit ensuite un `delivery_text` privé. L'acceptation par l'acheteur inscrit le gain fictif `sale` du vendeur. L'acheteur ne peut pas acheter sa propre offre.

En V3, une demande motivée de correction ramène une commande livrée à `paid`, avec `revision_requested=1`. L'ancienne livraison reste consultable mais n'est plus acceptable : le vendeur doit en envoyer une version différente, qui remet l'état à `delivered` et efface le drapeau. Les changements, demandes et livraisons alimentent `order_events`, dans la même transaction que l'état, les notifications, l'audit et les éventuelles écritures financières.

La `version` de commande est obligatoire pour livrer, demander une correction ou accepter. Les versions périmées sont rejetées avec HTTP 409 ; une acceptation ne doit jamais être réessayée automatiquement après relecture. Une répétition d'acceptation d'une commande déjà terminée ne crée pas un deuxième gain fictif. Les transitions de litige participent aussi au versionnement ; une ancienne livraison ne permet pas à la modération de contourner une correction encore attendue.

L'historique est paginé et privé aux participants. La modération conserve son accès contextuel à la dernière livraison et à l'état de la commande, pas une lecture générale des historiques. La migration reprend les anciens textes de livraison dans un événement `legacy_delivery` à date inconnue (`NULL`), sans attribuer artificiellement la date d'achat à leur livraison. Elle ne modifie ni les conditions commerciales historiques ni les montants.

Avant achèvement, un litige peut suspendre la commande (`disputed`). La modération peut la faire reprendre à `paid` ou `delivered` selon les preuves présentes. Les valeurs de schéma `refunded` et `refund` ne signifient pas qu'un service de remboursement réel, ou même un parcours automatique de remboursement, est implémenté.

La publication d'un concept ne prouve ni sa nouveauté, ni sa protection, ni les droits du vendeur. Alpha n'effectue pas de transfert légal automatique de marque, brevet ou droit d'auteur.

### Avis, échanges et modération

- Un avis devient possible après l'état `paid` d'une mission et concerne l'autre participant. Une seule évaluation par auteur et mission est autorisée. Le badge « vérifié » signifie **relation avec une mission payée en simulation**, pas identité vérifiée, transaction bancaire réelle ou certification de compétence.
- En V2, les notes de communication et de qualité sont facultatives, de 1 à 5. Les valeurs V1 restent `NULL` et sont exclues des moyennes détaillées. Chaque critère affiche son propre nombre de contributions ; le rôle évalué est déduit de la mission. Les jalons sont factuels, pas un score global de fiabilité. L'historique public n'affiche que des projets actuellement publics ; aucun pourcentage de ponctualité n'est calculé à partir de dates V1 insuffisantes.
- Les groupes communautaires et leurs publications sont publics. L'adhésion nécessaire pour publier dans un groupe ne rend pas les échanges confidentiels.
- Une conversation est consultable par ses membres. Les notifications appartiennent à leur destinataire et restent internes à l'application : aucun email ou SMS n'est envoyé.
- Un signalement appartient à son auteur et à la modération. Il passe de `open` à `reviewing`, puis à `resolved` ou `dismissed`. Les décisions et opérations suivies alimentent le journal d'audit.
- Lorsqu'un objet reste en litige, la clôture du dernier dossier actif exige un état de reprise explicite. L'administrateur peut consulter le contexte nécessaire, dont le rapport ou le texte de livraison concerné. Clôturer un signalement n'est pas une suppression automatique de contenu.

## Frontières de confiance et limites

### Identité et accès

Les mots de passe sont dérivés avec `scrypt` et un sel aléatoire. Le cookie contient un jeton aléatoire ; seul son condensat SHA-256 est stocké avec l'expiration de session. Les sessions durent sept jours. Le cookie est `HttpOnly`, `SameSite=Lax`, et `Secure` lorsque `NODE_ENV=production`.

La V3 expose au titulaire une liste paginée de ses sessions actives avec un identifiant public opaque distinct du jeton et de son condensat. Les sessions héritées gardent une date de création inconnue. Aucun suivi d'adresse IP ou d'appareil n'est ajouté. Le titulaire peut révoquer une autre session ou toutes les autres ; la session courante utilise le bouton de déconnexion.

Changer le mot de passe nécessite le mot de passe actuel. Le nouveau hash, la révocation des anciennes sessions et la création de la session de remplacement sont atomiques. Les vérifications asynchrones du mot de passe ne constituent pas une autorisation durable : la session et le hash observé sont revalidés avant validation de la transaction.

Les requêtes API modifiantes exigent l'en-tête `X-Alpha-Client: web` et vérifient l'origine lorsqu'elle est présente, avec `APP_ORIGIN` comme configuration explicite. L'interface fournit cet en-tête ; les clients API écrits séparément doivent le fournir aussi. Ce mécanisme complète le cookie, sans constituer une authentification à lui seul.

Les autorisations sont contrôlées côté serveur sur les ressources et les participants, pas seulement par l'affichage des boutons. L'administrateur de plateforme n'obtient pas une lecture générale de toutes les conversations ou de tous les projets privés ; les outils de modération lui donnent un accès contextuel aux éléments signalés.

Une limitation en mémoire protège les tentatives de connexion et d'inscription. Elle est locale au processus, réinitialisée au redémarrage, et ne constitue pas une protection complète contre les abus.

### Contenus et confidentialité

Les textes utilisateurs sont rendus comme du texte, et les liens de preuve sont limités à HTTP/HTTPS. Les liens d'intégration sont limités aux domaines HTTPS autorisés des fournisseurs ; ils ne donnent lieu à aucun téléchargement ou appel distant du serveur.

Il n'existe pas de téléversement, d'analyse antivirus, d'environnement d'exécution de logiciel ou de bac à sable pour les projets des membres. Les essais de logiciels externes restent sous la responsabilité des participants : utiliser un environnement adapté, ne pas fournir d'identifiants personnels et ne pas suivre aveuglément une URL.

La base stocke les messages, rapports et livraisons en clair au niveau applicatif. La confidentialité repose sur les autorisations de l'application et l'accès au fichier SQLite, pas sur un chiffrement de bout en bout. L'accès au serveur ou à une copie de la base donne accès à ces données. Les utilisateurs doivent aussi éviter de révéler des informations privées dans des publications ou avis publics.

L'export JSON est réservé aux responsables du projet autorisé et contient les campagnes, missions et rapports de ce projet. Il ne transforme pas un projet privé en ressource publique. Un export peut toutefois contenir des informations sensibles saisies dans les rapports : le traiter comme un document confidentiel.

### Argent et conformité

Le registre local est une simulation métier, **pas** un séquestre, un portefeuille électronique, une comptabilité réglementaire ou un système de paiement. Il n'y a ni carte bancaire, ni paiement mobile, ni retrait, ni KYC, ni garantie de remboursement. Les exemples de prix ou de récompenses n'engagent aucun versement réel.

Les en-têtes HTTP, validations et contraintes SQL présents constituent des protections initiales, pas un audit de sécurité ni une conformité juridique démontrée. Les tests exécutables du dépôt et le parcours manuel du README ne couvrent pas à eux seuls tous les navigateurs, les scénarios d'abus ou les exigences de production.

## Avant une mise en production

Travaux à concevoir et valider avant une ouverture publique, et impérativement avant tout argent réel :

1. **Paiement et cadre légal** : sélectionner un PSP adapté à la marketplace et aux pays effectivement servis ; définir KYC/KYB, bénéficiaires, restrictions de pays et d'âge, obligations fiscales, facturation, contrats, licences, consentement, réclamations, remboursements et protection des données. Faire valider les parcours par des spécialistes compétents.
2. **Fraude et abus** : limiter durablement les requêtes au-delà de l'authentification, protéger inscriptions et messagerie, détecter multi-comptes, collusion et avis artificiels, définir quotas, signalements, sanctions et procédures de recours.
3. **Pièces jointes et logiciels** : avant d'ajouter un upload, prévoir stockage privé, limites, quarantaine, analyse, contrôle des types et liens d'accès temporaires. Toute exécution de logiciel non fiable nécessite une isolation dédiée ; ne jamais lancer des projets clients dans le processus API.
4. **Cycle de vie des comptes** : vérification d'adresse, envoi d'emails fiable, récupération de mot de passe et procédures de suppression/export des données personnelles. Le changement de mot de passe et la révocation des sessions existent en V3 ; ils ne constituent pas une récupération de compte ni une authentification multifacteur.
5. **Migrations et stockage** : étendre les migrations versionnées de la V2 pour les évolutions futures, tester sauvegardes et procédures de restauration à l'échelle réelle. Évaluer une migration vers PostgreSQL lorsque les besoins de concurrence, d'exploitation ou de volume le justifient, sans prétendre qu'elle existe aujourd'hui.
6. **Traitement asynchrone avant paiement réel** : worker et outbox transactionnelle, clés d'idempotence, validation des signatures de webhooks, déduplication, reprises, rapprochement avec le PSP et journal financier auditable. Ne pas supposer qu'une transaction SQLite rend atomique un futur appel réseau.
7. **Exploitation** : HTTPS, configuration sûre du reverse proxy, secrets et droits système, journaux structurés sans données sensibles, métriques, alertes, suivi des erreurs, sauvegardes cohérentes avec WAL, tests de restauration et politiques de rétention.
8. **Validation continue** : compléter les tests d'autorisations et transitions, de concurrence, de confidentialité, de restauration et les parcours navigateur ; vérifier accessibilité et charge. Ne pas assimiler un build réussi à ces vérifications.

Ces éléments sont un travail restant à réaliser, pas des fonctionnalités activées par un changement de variable d'environnement.
