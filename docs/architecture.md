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

