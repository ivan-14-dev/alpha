# Alpha — V3

Une plateforme francophone pour partager des projets technologiques, organiser des tests rémunérés **en simulation**, trouver des collaborateurs et échanger avec une communauté.

Alpha est une application locale persistante : interface React 19 et TypeScript, Vite, API Express 5 et SQLite via `node:sqlite`. Les treize modules métier partagent une base de données ; ce ne sont pas des microservices.

> **Tous les financements, achats, gains et versements sont simulés.** Aucun prestataire de paiement n'est connecté, aucun argent réel ne circule et aucun retrait réel n'est disponible. Cette version ne doit pas être présentée comme une plateforme prête pour la production.

## Nouveautés de la V3

- **Recherche globale** : retrouver projets publics, campagnes, offres actives et talents ; filtrer par type et parcourir les résultats.
- **Favoris privés** : enregistrer projets, campagnes et offres dans sa bibliothèque, sans notification à leurs auteurs. Les ressources devenues privées ou archivées disparaissent des résultats et des compteurs.
- **Livraisons suivies** : consulter l'historique privé d'une commande, demander des corrections et recevoir une nouvelle livraison avant de l'accepter. Une modification concurrente provoque un conflit explicite ; l'acceptation vise la version consultée.
- **Contrôle du compte** : changer son mot de passe, consulter ses sessions actives et révoquer les autres connexions. Un changement de mot de passe renouvelle la session actuelle et invalide les anciennes.

Les paiements demeurent fictifs. La recherche ne parcourt ni les projets privés, ni les rapports, messages ou livraisons. Une ancienne livraison est conservée dans l'historique sans lui inventer une date de livraison.

### Déjà disponibles depuis la V2

- **Mon réseau** : suivre des membres et des projets publics, retrouver ses abonnements et un fil personnalisé dans les communautés.
- **Actualités de projet** : publier des avancées liées à un projet public. Passer le projet en privé retire ces publications de tous les fils, commentaires et interactions publics.
- **Équipes sur invitation** : accepter ou décliner les accès proposés avant de devenir membre ; invitations valables sept jours, révocation et départ d'une équipe.
- **Atelier d'équipe** : tableaux de tâches privés, responsables, échéances, priorités et états À faire / En cours / Terminé. Les modifications concurrentes sont détectées plutôt qu'écrasées.
- **Réputation détaillée** : évaluations facultatives de la communication et de la qualité, distinction entre testeur et porteur de projet, historique public et jalons fondés sur des collaborations terminées.

### Mettre à jour une installation V1 ou V2

Arrêter l'ancienne application et conserver une sauvegarde cohérente de sa base SQLite avant la mise à jour. Puis relancer normalement : les migrations manquantes sont appliquées automatiquement, dans une transaction, au démarrage de l'API.

Les comptes, sessions, messages, projets, missions et opérations fictives existants sont conservés. Les anciennes évaluations n'obtiennent pas de nouvelles notes inventées. Les nouvelles tables de favoris, abonnements, invitations et tâches restent vides tant que vous n'en créez pas ; le seed ne réinjecte rien dans une base existante. Les anciennes sessions restent valides jusqu'à leur expiration ou révocation, avec une date de création indiquée comme inconnue.

Les migrations appliquées sont enregistrées avec une empreinte de leur contenu. Ne pas modifier un fichier SQL déjà appliqué : ajouter une nouvelle migration. Une migration en échec est annulée et empêche le démarrage, sans prétendre que la mise à jour a réussi. Le retour à un ancien schéma n'est pas automatisé.

## Démarrer en quelques minutes

Prérequis : **Node.js 22.13 ou supérieur** et npm. Exécuter les commandes à la racine du dépôt.

```bash
npm install

# Facultatif, uniquement sur une base vide :
npm run seed

npm run dev
```

- Interface : `http://127.0.0.1:5173`.
- API : `http://127.0.0.1:3001/api`.
- Diagnostic : `http://127.0.0.1:3001/api/health`.

Vite relaie `/api` vers l'API : ouvrir l'interface sur le port 5173 en développement. Les données sont conservées dans `data/alpha.sqlite`, créé automatiquement et ignoré par Git. Aucun service de base de données externe n'est nécessaire. Selon la version de Node, un avertissement concernant le caractère expérimental de SQLite peut apparaître.

Sans jeu de démonstration, utiliser **Rejoindre Alpha** pour créer son compte. Les espaces vides peuvent ensuite être alimentés depuis l'interface.

### Comptes de démonstration

`npm run seed` crée des données fictives et refuse de s'exécuter si la base contient déjà des comptes. Il ne réinitialise pas une installation existante.

| Adresse | Parcours conseillé |
| --- | --- |
| `camille@alpha.test` | Création de projets et gestion de campagnes |
| `alex@alpha.test` | Candidatures, rapports de test et avis |
| `admin@alpha.test` | Traitement des signalements et journal d'audit |

Le seed utilise `DEMO_PASSWORD` si cette variable est fournie ; sinon, il **génère un mot de passe aléatoire et l'affiche une fois dans le terminal**. Le même mot de passe est utilisé pour les comptes fictifs de cette base. Aucun mot de passe de démonstration n'est codé en dur. Conserver celui généré localement, sans le publier ni le committer.

Pour repartir sur une démonstration distincte sans supprimer des données, choisir un nouveau `DATABASE_PATH` et utiliser ce même chemin pour le seed et le serveur.

### Configuration facultative

```bash
cp .env.example .env
```

Le fichier `.env` local est chargé par Node côté serveur et lors du seed ; les variables déjà fournies par l'environnement restent prioritaires. Il est ignoré par Git.

| Variable | Valeur ou usage |
| --- | --- |
| `PORT` | Port de l'API, `3001` par défaut. Le serveur écoute sur `127.0.0.1`. |
| `DATABASE_PATH` | Fichier SQLite, `./data/alpha.sqlite` par défaut ; chemin relatif à la racine lorsque les commandes y sont lancées. |
| `APP_ORIGIN` | Origine exacte autorisée pour les requêtes de modification, par exemple `http://127.0.0.1:5173` en développement. Ne pas ajouter de `/` final. |
| `DEMO_PASSWORD` | Mot de passe facultatif des comptes créés par le seed. Choisir une valeur longue et unique, de 10 à 128 caractères. Ne crée aucun compte au démarrage normal. |
| `NODE_ENV` | `production` active notamment le cookie de session `Secure` et impose `APP_ORIGIN` ; nécessite HTTPS côté navigateur. Ne pas l'utiliser pour l'essai local en HTTP. |

`APP_ORIGIN` participe à la protection contre les requêtes intersites (CSRF), avec un en-tête applicatif envoyé par le client. Si la connexion échoue avec « Origine non autorisée », vérifier l'adresse utilisée dans le navigateur : `localhost` et `127.0.0.1` sont des origines différentes. En l'absence de configuration, les origines locales usuelles des ports 5173 et 3001 sont acceptées.

En développement, `PORT` configure aussi la cible du proxy Vite. Le port de l'interface reste fixé à 5173 : s'il est occupé, Vite s'arrête au lieu d'en choisir silencieusement un autre.

### Servir la version compilée

```bash
npm run build
APP_ORIGIN=http://127.0.0.1:3001 npm start
```

Ouvrir alors `http://127.0.0.1:3001`. Express sert le dossier `dist` et l'API sur la même origine. `npm start` n'effectue ni build ni seed ; le serveur TypeScript est lancé avec `tsx`.

Pour un déploiement derrière un reverse proxy HTTPS, fournir l'origine publique exacte et `NODE_ENV=production`. Cela ne remplace pas les travaux de durcissement décrits dans [l'architecture](docs/architecture.md#avant-une-mise-en-production).

## Ce que l'on peut faire

1. **Projets** : publier un projet, renseigner ses technologies et ses liens, choisir une visibilité publique ou privée.
2. **Tests** : créer une campagne, recueillir des candidatures, sélectionner des testeurs et suivre leurs rapports structurés.
3. **Communautés** : rejoindre des groupes publics, publier, commenter et réagir.
4. **Marketplace** : proposer des logiciels, composants, prototypes, services ou dossiers de concepts, puis suivre une commande simulée.
5. **Paiements** : financer un budget fictif, réserver les récompenses, déclencher un versement de démonstration et consulter son historique.
6. **Profils et organisations** : présenter ses compétences et réunir des membres autour de projets.
7. **Réputation** : consulter et laisser des avis entre participants d'une mission ayant atteint l'état payé en démonstration.
8. **Communication** : échanger dans des conversations privées et consulter ses notifications internes.
9. **Confiance** : signaler un contenu ou un litige ; permettre à un administrateur d'examiner le dossier et de documenter sa décision.
10. **Intégrations** : enregistrer des liens GitHub, GitLab, Linear ou Figma et exporter les rapports d'un projet autorisé en JSON.
11. **Réseau** : suivre des personnes et des projets publics, puis filtrer le fil selon ses abonnements et ses communautés.
12. **Atelier d'équipe** : organiser les tâches d'un projet entre ses collaborateurs autorisés, indépendamment des missions de test rémunérées.
13. **Découverte et favoris** : rechercher entre les modules publics et conserver une sélection personnelle, distincte des abonnements sociaux.

Les intégrations sont des **liens enregistrés**, pas des connexions OAuth ni des synchronisations. Les rapports contiennent du texte et, éventuellement, une URL de preuve déjà hébergée. Alpha n'héberge ni ne lance les logiciels à tester et ne propose pas de téléversement de pièces jointes.

Les offres de marketplace portent sur des **droits non exclusifs** précisés par le vendeur, pas sur un transfert automatique de propriété intellectuelle. La description des livrables est publique ; le texte de livraison d'une commande est privé aux participants, avec accès contextuel de la modération en cas de signalement.

## Parcours manuel créateur → testeur

Utiliser deux profils de navigateur distincts, ou se déconnecter entre les rôles : deux onglets du même profil partagent le cookie de session.

1. **Camille** : ouvrir **Explorer les projets**, choisir Flowboard ou créer un projet public. Dans **Missions de test**, créer une campagne avec des consignes, une récompense, des places et une échéance future.
2. **Camille** : suivre **Financer la campagne** et enregistrer un financement fictif suffisant. Aucun paiement bancaire n'est demandé.
3. **Alex** : ouvrir la campagne et envoyer une candidature motivée. Pour essayer directement la campagne préchargée « Un premier regard sur Flowboard », une candidature d'Alex existe déjà et son budget est déjà financé.
4. **Camille** : ouvrir les candidatures et **Sélectionner** Alex. La récompense est réservée ; une mission apparaît pour les deux participants.
5. **Alex** : **Commencer la mission**, puis **Rédiger mon rapport**. Renseigner une synthèse, les étapes de reproduction, le résultat attendu et le résultat observé. La preuve par URL est facultative.
6. **Camille** : **Valider le rapport**, ou **Demander des corrections** pour permettre une nouvelle soumission. La validation ne déclenche pas automatiquement de versement.
7. **Camille** : déclencher **Verser … (démo)**. **Alex** peut vérifier l'opération dans **Paiements** ; elle ne correspond à aucun gain retirable.
8. **Les deux participants** : ouvrir **Avis & réputation** pour évaluer la collaboration. La rémunération fictive porte sur le travail de test, jamais sur l'obligation de donner un avis positif.

Pour explorer les autres parcours :

- **Marketplace** : un vendeur publie une offre ; un autre compte l'achète en simulation ; le vendeur saisit une livraison privée ; l'acheteur l'accepte. Le gain fictif du vendeur est enregistré à l'acceptation.
- **Collaboration** : créer une organisation dans **Mon compte**, inviter des membres inscrits, puis lui rattacher un projet. Les accès ne sont accordés qu'après acceptation. Les communautés restent publiques, même lorsque certains projets sont privés.
- **Litige** : avant le règlement final, ouvrir un litige depuis une mission ou une commande. Avec `admin@alpha.test`, examiner le dossier dans **Confiance & sécurité** et choisir explicitement une reprise autorisée lors de sa clôture. Aucune décision ne transfère ni ne rembourse automatiquement de l'argent.

## Essayer les parcours V2

**Réseau et actualités** : ouvrir le profil d'un autre membre ou la fiche d'un projet public, puis **Suivre**. Dans **Mon réseau**, retrouver ses abonnements ; dans **Communautés**, ouvrir le fil personnalisé. Un responsable peut publier une actualité pour son projet public depuis le compositeur. Suivre quelqu'un ne donne aucun droit sur ses projets privés.

**Invitation et tâches** : avec Camille, ouvrir **Mon compte**, sélectionner Studio Collectif et inviter un compte qui n'en fait pas partie. Avec ce compte, accepter l'invitation dans **Mon compte**. Le projet rattaché apparaît alors dans **Atelier d'équipe**. Camille peut créer et assigner une tâche ; son destinataire peut en modifier l'état. Les membres ordinaires ne peuvent pas réassigner les tâches ou modifier leurs consignes.

Sur une base nouvellement initialisée en V2, Alex reçoit déjà une invitation au Studio Collectif et Flowboard dispose d'un tableau de tâches d'exemple. Sur une base V1 mise à jour, les créer depuis l'interface : aucune collaboration n'est ajoutée sans action de l'utilisateur.

**Réputation** : après une mission payée en simulation, les participants peuvent compléter la note globale par des appréciations facultatives de la communication et de la qualité. Les moyennes affichent le nombre d'avis qui les fondent ; une ancienne note globale ne compte pas comme une note détaillée. Les projets privés ne sont jamais nommés dans l'historique public.

## Essayer les parcours V3

**Découverte** : utiliser la recherche du bandeau ou **Rechercher sur Alpha**, puis filtrer les résultats. Choisir **Enregistrer** sur un projet, une campagne ou une offre ; retrouver ces éléments dans **Mes favoris**. Les profils se suivent via le réseau, ils ne sont pas ajoutés aux favoris. Une campagne fermée peut rester consultable ; un favori ne réserve aucune place et n'achète rien.

**Commande et corrections** : acheter une offre en simulation et ouvrir sa commande. Le vendeur livre un texte privé ; l'acheteur peut demander des corrections motivées ou accepter la livraison. Après une demande, le vendeur doit envoyer une livraison modifiée. Le gain fictif du vendeur n'est créé qu'après acceptation, une seule fois. L'historique est réservé aux participants. En cas de litige, la modération peut consulter la dernière livraison et le contexte autorisé de la commande.

Sur une base nouvellement initialisée en V3, Camille a commandé une revue UX à Alex et demandé des précisions. Avec Alex, ouvrir **Marketplace → Achats et ventes**, consulter la commande et livrer une version corrigée ; avec Camille, vérifier puis accepter. Alex dispose aussi de trois favoris d'exemple. Une base existante n'est pas alimentée automatiquement.

**Compte** : ouvrir **Mon compte** pour consulter les sessions actives et révoquer une autre connexion. Pour vérifier ce parcours, utiliser deux profils de navigateur distincts ; deux onglets ordinaires partagent le même cookie. Le changement de mot de passe exige le mot de passe actuel et déconnecte les anciennes sessions. Il ne remplace pas une récupération de compte par email, qui reste absente.

**Clients API existants** : les mutations de livraison et d'acceptation des commandes exigent désormais le champ `version` renvoyé par la commande. Après un conflit HTTP 409, relire la commande et vérifier son contenu avant de confirmer à nouveau ; ne pas renvoyer automatiquement une acceptation sur une nouvelle version.

## Vérifications et structure

```bash
npm run typecheck
npm test
npm run build
```

`typecheck` vérifie TypeScript ; `test` exécute les fichiers `tests/*.test.ts` avec le runner Node via `tsx` ; `build` vérifie les types puis compile l'interface avec Vite. Ces commandes ne constituent pas une certification de sécurité ou de conformité. Le parcours ci-dessus est une vérification manuelle distincte.

```text
src/pages/          Écrans des modules métier
src/components/     Composants d'interface partagés
src/lib/            Client API et contexte de session
server/modules/     Treize routeurs métier
server/auth.ts      Comptes et sessions
server/core.ts      Autorisations et utilitaires partagés
server/finance.ts   Règles des budgets et versements simulés
server/schema.sql   Socle SQLite V1
server/migrations/  Migrations SQL versionnées V2 et V3
server/migrations.ts  Application transactionnelle et vérification des empreintes
server/seed.ts      Données fictives facultatives
docs/architecture.md  Frontières, cycles de vie et limites
```

Les comptes, messages, rapports et livraisons restent dans la base locale. Ne pas y déposer de secrets ou de données sensibles : cette version n'inclut ni messagerie chiffrée de bout en bout, ni analyse de fichiers, ni récupération de mot de passe par email. Pour les choix de conception et le travail nécessaire avant ouverture au public, consulter [l'architecture détaillée](docs/architecture.md).
