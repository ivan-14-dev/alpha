# Confiance et anti-abus (V4)

Ce module protège la plateforme contre plusieurs abus :

- la fraude ;
- les comptes multiples ;
- la collusion entre propriétaires de campagnes et testeurs payés ;
- les cercles d’avis ;
- les transactions avec soi-même sur la marketplace.

Il s’appuie sur trois éléments, sans jamais stocker d’adresse IP ni d’identifiant d’appareil en clair :

- des **signaux** pseudonymisés ;
- des **détecteurs** qui ouvrent des dossiers à examiner ;
- une **échelle de sanctions** motivées et contestables.

Les signalements et litiges V3 (missions, commandes, projets, publications, annonces) restent inchangés. Une résolution « remboursement depuis le séquestre » s’y ajoute pour les commandes réellement payées (voir plus bas).

> Ce document décrit des choix techniques et organisationnels. Il ne constitue pas un avis juridique : faites valider par un juriste la qualification de l’intérêt légitime, les durées de conservation et les obligations DSA applicables à la taille de l’opérateur.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/012-trust.sql` |
| Contrat (restrictions, middleware, signaux, niveau de risque) | `server/platform/guards.ts` |
| Signaux (empreintes, nettoyage des métadonnées) | `server/trust/signals.ts`, `server/trust/context.ts` |
| Événements métier → signaux | `server/trust/events.ts` |
| Détecteurs et tâches planifiées | `server/trust/detectors.ts` |
| Dossiers de risque et niveau de risque | `server/trust/cases.ts` |
| Sanctions et exposé des motifs | `server/trust/sanctions.ts` |
| Appels | `server/trust/appeals.ts` |
| Administration des membres | `server/trust/users.ts`, `server/trust/admin.ts` |
| API membre | `server/trust/member.ts` |
| Paramètres | `server/trust/settings.ts` |
| Remboursement des litiges (séquestre) | `server/trust/disputes.ts`, `server/modules/trust.ts` |
| RGPD | `server/trust/privacy.ts` |
| Client | `src/pages/TrustPage.tsx`, `src/admin/UsersAdmin.tsx`, `src/admin/RiskAdmin.tsx`, `src/admin/AppealsAdmin.tsx`, `src/styles/trust.css` |
| Tests | `tests/trust-v4.test.ts` |

## Signaux et vie privée

### Ce qui est collecté

Chaque signal (`risk_signals`) contient les champs suivants :

- un type ;
- l’identifiant du membre, s’il est connu ;
- une date ;
- au plus trois **empreintes à clé** ;
- des métadonnées non identifiantes.

| Donnée source | Traitement | Colonne |
| --- | --- | --- |
| Adresse IP du client (`clientIp`, qui respecte `TRUST_PROXY`) | IPv4 telle quelle, IPv6 réduite à son préfixe /64, puis HMAC-SHA-256 avec l’usage `trust.ip` | `ip_hash` + `ip_scope` |
| En-tête `X-Alpha-Device` (UUID aléatoire tiré par le navigateur dans `localStorage`, voir `src/lib/api.ts`) | HMAC-SHA-256 avec l’usage `trust.device` ; ignoré si la valeur est invalide ou vaut `unavailable` | `device_hash` |
| User-Agent (512 caractères au plus) | HMAC-SHA-256 avec l’usage `trust.ua` | `ua_hash` |

Le champ `ip_scope` prend l’une des valeurs suivantes :

- `public` ;
- `private` : boucle locale, RFC 1918, CGNAT 100.64/10, lien local, multicast ;
- `none`.

Les adresses **privées ne sont jamais utilisées pour rapprocher des comptes**. Ce sont typiquement :

- les réseaux d’entreprise ;
- les réseaux mobiles en CGNAT ;
- les tests locaux.

Les empreintes utilisent la clé du trousseau (`keyedHash`, `server/platform/secrets.ts`). Sans cette clé, il est impossible de retrouver une adresse ou un identifiant par force brute.

Après une rotation de clé, les nouvelles empreintes ne se rapprochent plus des anciennes. La détection repart alors de zéro sur la fenêtre glissante, ce qui est accepté.

Les métadonnées (`sanitizeMeta`) obéissent aux règles suivantes :

- au plus 12 champs scalaires ;
- clés en minuscules ;
- sont rejetés :
  - les clés contenant `email`, `ip`, `phone`, `name`, `token`, `note`, `message`, etc. ;
  - les textes libres ;
  - les adresses IP ;
  - les numéros de téléphone.

Il ne reste que des identifiants techniques, des énumérations et des montants.

Les signaux fréquents (`message`, `order`, `mission`) sont dédoublonnés : au plus un signal par fenêtre de 5 à 15 minutes et par empreinte. `recordSignal` ne lève jamais d’exception : une erreur est journalisée et seule l’écriture du signal est annulée.

### Sources

- **Authentification** (`server/auth.ts`, module comptes) :
  - `register` ;
  - `login` ;
  - `login_failed` ;
  - `oauth_login` ;
  - `password_reset` ;
  - `mfa_failed`.
- **Événements métier** (`onDomainEvent('trust.signals', …)`, écritures en base uniquement, dans la transaction métier) :

| Action auditée | Signal |
| --- | --- |
| `review.created` | `review` |
| `marketplace.listing.created` | `listing` |
| `demo.marketplace.purchased`, `*.order.paid` / `purchased` | `payment` (+ contrôle d’auto-transaction de la commande) |
| `*.campaign.funded` | `payment` |
| `payment(s).(intent.)failed` | `payment` (`status=failed`) |
| `*.mission.paid` | `payout` attribué au testeur, sans empreinte (+ contrôle de collusion de la paire) |
| `*.withdrawal.requested` / `created` | `withdrawal` |
| `application.created`, `mission.started` / `submitted`, `report.submitted` / `revised` | `mission` |
| `marketplace.order.*`, `payments.order.released` | `order` |

L’empreinte de la requête n’est rattachée à un signal que si la requête courante émane **du membre concerné**. Elle n’est jamais rattachée pour :

- un webhook ;
- une tâche planifiée ;
- l’action d’un autre membre.

### Base légale et conservation

La base légale est l’intérêt légitime (RGPD, art. 6(1)(f) et considérant 47 : prévention de la fraude).

| Donnée | Durée | Réglage |
| --- | --- | --- |
| Signaux | 180 jours | `privacy.retention.risk_signals_days` (module vie privée), purge quotidienne `trust.purge` |
| Dossiers classés sans suite | 365 jours après clôture | `trust.retention.dismissed_cases_days` |
| Dossiers ayant donné lieu à sanction | 5 ans après clôture | `trust.retention.sanctions_years` |
| Sanctions levées ou expirées, et leurs appels | 5 ans après la fin | `trust.retention.sanctions_years` |
| Sanctions en cours | durée de la sanction | — |

**Droits des personnes** (`registerPersonalData('trust')`) :

- **L’export** contient :
  - les sanctions du membre, sous forme d’exposé des motifs public ;
  - ses appels ;
  - la liste datée de ses signaux, sans les empreintes.

  Il exclut :
  - les notes internes ;
  - les auteurs des décisions ;
  - les autres membres ;
  - le contenu des dossiers de risque. Leur divulgation compromettrait la prévention de la fraude (RGPD, art. 23(1)(d) et (i)).
- **L’effacement** supprime les signaux et les dossiers classés sans suite. Les sanctions et les appels sont conservés au titre de l’intérêt légitime :
  - preuve de la décision ;
  - exposé des motifs DSA ;
  - prévention de la récidive.

  Ils sont purgés selon le tableau ci-dessus.

## Détecteurs et seuils

La tâche `trust.detect` (toutes les 10 minutes, ou « Lancer la détection » dans l’administration) exécute chaque détecteur dans sa propre transaction. Les détecteurs « appareil partagé », « inscriptions » et « auto-transaction » tournent aussi en ligne, dès le signal concerné.

Les dossiers sont **idempotents** :

- une clé de déduplication (`dedupe_key`, index unique sur les dossiers actifs) garantit un seul dossier ouvert par motif ;
- une nouvelle détection rafraîchit le score (maximum) et fusionne les membres liés ;
- un dossier clos n’est pas rouvert pendant `dismissed_cooldown_days` pour les mêmes membres.

| Détecteur | Règle | Score | Clé | Seuils (`trust.thresholds`) |
| --- | --- | --- | --- | --- |
| Appareil partagé (`multi_account`) | ≥ N comptes distincts sur la même empreinte d’appareil dans la fenêtre | 55 pour 2 comptes, 70 et plus à partir de 3 | `multi_account:device:<empreinte>` | `multi_account_device_users` = 2, `window_days` = 30 |
| Inscriptions groupées (`multi_account`) | ≥ N inscriptions depuis une même IP **publique** en 24 h | 40 à 60 | `multi_account:ip:<empreinte>` | `ip_registrations_per_day` = 5 |
| Collusion | Propriétaire de campagne et testeur payé partageant un appareil (75) ou une IP publique (50) ; ou ≥ N versements du même propriétaire au même testeur (45 à 65) | jusqu’à 95 | `collusion:<propriétaire>:<testeur>` | `collusion_window_days` = 90, `collusion_repeat_payouts` = 3 |
| Cercle d’avis (`review_ring`) | Avis positifs (≥ 4) réciproques sur des campagnes de propriétaires différents, regroupés en composantes connexes ; bonus si au moins 2 comptes récents | 45 pour 2 membres, 60 et plus à partir de 3 | `review_ring:<groupe>` | `review_window_days` = 90, `new_account_days` = 7 |
| Rafale d’avis (`review_ring`) | ≥ N avis positifs reçus en H heures de comptes de moins de `new_account_days` jours | 65 | `review_ring:burst:<membre>` | `review_burst_count` = 5, `review_burst_hours` = 24 |
| Vélocité, authentification | ≥ N échecs de connexion ou de double authentification en 1 h (compte possiblement **ciblé**) | 45 | `velocity:auth:<membre>` | `failed_logins_per_hour` = 10 |
| Vélocité, retrait | Retrait demandé moins de H heures après un paiement entrant (signaux, ou `withdrawals` + `payment_intents` si ces tables existent) | 50 | `velocity:withdrawal:<membre>` | `withdrawal_after_funding_hours` = 24 |
| Échecs de paiement (`payment_fraud`) | ≥ N paiements échoués en 24 h (signaux et `payment_intents` si la table existe) | 50 à 80 | `payment_fraud:failures:<membre>` | `payment_failures_per_day` = 5 |
| Auto-transaction (`self_dealing`) | Acheteur et vendeur partageant un appareil (75) ou une IP publique (50), +5 par commande supplémentaire | jusqu’à 90 | `self_dealing:<vendeur>:<acheteur>` | `collusion_window_days` |

Le contenu de `evidence` est limité :

- empreintes **tronquées** à 12 caractères ;
- identifiants de ressources ;
- comptages ;
- dates.

On n’y trouve jamais d’adresse, d’e-mail ni de texte rédigé par un membre. Le compte principal d’un dossier multi-comptes est le plus récent.

### Niveau de risque (`riskLevel`)

- **high** : un dossier actif de score ≥ 70, ou une suspension ou un bannissement en cours ;
- **medium** : un dossier actif de score ≥ 40, ou au moins `failed_logins_per_hour` échecs d’authentification en 24 h ;
- **low** : sinon.

Les membres liés à un dossier partagent son score. Le module conformité (`server/compliance/withdrawals.ts`) lit `riskLevel` pour basculer les retraits en revue manuelle.

### Mesures automatiques (`trust.auto_actions`)

Une seule mesure existe : `hold_withdrawals_on_high_risk`, **désactivée par défaut**. Une fois activée, elle place une **restriction `withdraw`** sur les membres non administrateurs de niveau `high` liés à un dossier actif de score ≥ 70.

Cette restriction :

- est automatisée et contestable ;
- dure `hold_days` jours (14 par défaut) ;
- est levée automatiquement quand la modération classe le dossier ou le remplace par sa propre décision ;
- n’est jamais réappliquée par le même dossier.

**Aucun avertissement, aucune suspension et aucun bannissement n’est jamais automatique.**

## Échelle des sanctions

| Sanction | Effet | Connexion | Sessions |
| --- | --- | --- | --- |
| `warning` | Aucun blocage, notification et exposé des motifs uniquement | oui | conservées |
| `restriction` | Bloque uniquement les capacités choisies (`publish`, `message`, `trade`, `money`, `withdraw`, `review`, `test`) | oui | conservées |
| `suspension` | Bloque toutes les mutations, sauf les routes d’autonomie | oui, pour lire la décision et faire appel | conservées |
| `ban` contestable | Comme une suspension | oui, pour faire appel | **révoquées** |
| `ban` non contestable | Bloque aussi la connexion (`accountRestriction(id,'login')`) ; `attachUser` traite le compte comme déconnecté | **non** | **révoquées** |

Une sanction est active si elle remplit trois conditions :

- `starts_at` est passé ;
- `ends_at` est vide ou dans le futur ;
- elle n’est pas révoquée.

Contraintes vérifiées par la base et par l’API :

- seul un bannissement peut être non contestable ;
- une restriction exige au moins une capacité ;
- le motif public compte de 10 à 2000 caractères ;
- un administrateur ne peut pas se sanctionner lui-même ;
- sanctionner un autre administrateur exige une confirmation explicite (`confirm_admin`).

### Correspondance des capacités (`capabilityMiddleware`)

Le middleware est monté après `attachUser`. Il ne concerne que les méthodes POST, PUT, PATCH et DELETE. Le chemin est d’abord normalisé : mise en minuscules, décodage, fusion des `//`.

| Préfixe | Capacité |
| --- | --- |
| `/api/projects`, `/api/community`, `/api/workspace`, `/api/people`, `/api/network`, `/api/discovery`, `/api/integrations`, `/api/files` | `publish` |
| `/api/communication`, `/api/realtime/typing` | `message` |
| `/api/marketplace` | `trade` |
| `/api/payments`, `/api/compliance` | `money` |
| `/api/compliance/withdrawals`, `/api/compliance/payout-methods` | `withdraw` |
| `/api/reputation` | `review` |
| `/api/testing`, `/api/sandbox` | `test` |
| Ouverture d’un litige ou d’un signalement, outils `/api/<module>/admin`, préfixes non listés | aucune : seuls une suspension ou un bannissement bloquent |

Les routes suivantes restent **toujours autorisées** :

- toutes les requêtes GET ;
- `/api/auth/*` (dont la déconnexion) ;
- `/api/trust/appeals` et `/api/trust/me/*` ;
- `/api/privacy/*` (droits RGPD) ;
- les webhooks de paiement et d’intégration ;
- les notifications et les accusés de lecture.

Une requête refusée reçoit un `403 {error, restriction}`. L’objet `restriction` contient les champs suivants :

- `sanction_id` ;
- `kind` ;
- `message` (motif public) ;
- `until` ;
- `appealable` ;
- `capability`.

Les modules peuvent aussi appeler `requireCapability(req, cap)` dans leurs routes, qui lève une `RestrictionError`.

## Appels

| Règle | Valeur |
| --- | --- |
| Délai pour contester | 180 jours après la décision (`trust.appeals.window_days`, au moins 6 mois : DSA, art. 20(1)) |
| Délai de traitement visé (SLA) | 7 jours (`trust.appeals.sla_days`). Les appels en retard sont signalés dans l’administration. |
| Appels en cours | au plus 1 par sanction (index unique partiel) |
| Appels au total | au plus 2 par sanction (déclencheur `appeals_per_sanction_limit`) |
| Argumentaire | 30 à 3000 caractères |
| Limite de débit | 10 appels par 24 h et par membre |
| Décision | Humaine, par un administrateur. Un appel accepté lève la sanction dans la même transaction. Un rejet doit être motivé (au moins 10 caractères), et le motif est communiqué au membre. |

Des notifications sont envoyées dans les cas suivants :

- création d’une sanction (avec un e-mail pour une suspension ou un bannissement) ;
- levée d’une sanction ;
- dépôt d’un appel (au membre et aux administrateurs) ;
- décision sur un appel.

## Exigences DSA (règlement (UE) 2022/2065)

### Exposé des motifs (art. 17)

L’exposé des motifs est fourni pour chaque sanction :

- dans la page « Mes restrictions & appels » ;
- dans `GET /api/trust/me/restrictions` ;
- dans la notification de la sanction.

Il contient les éléments suivants :

| Exigence de l’art. 17(3) | Champ |
| --- | --- |
| Nature et portée de la mesure, durée | `kind`, `capabilities`, `starts_at`, `ends_at`, `login_blocked` |
| Faits et circonstances | `public_reason`, rédigé pour le membre et distinct de `internal_note`, qui n’est jamais exposée |
| Recours à des moyens automatisés, pour la détection et pour la décision | `automated_detection` (sanction issue d’un dossier de détection) et `automated_decision` (retenue automatique des retraits) |
| Fondement contractuel ou légal | `ground` / `ground_label` (ex. « Conditions d’utilisation — comptes multiples ou usurpation », « Contenu ou activité illicite ») |
| Voies de recours | appel interne (si `appealable`), organisme de règlement extrajudiciaire certifié (art. 21), juridictions compétentes (`redress`) |

### Autres articles

- **Art. 20** (traitement interne des réclamations) :
  - accessible depuis le compte, même suspendu ;
  - gratuit ;
  - au moins 6 mois ;
  - décision humaine, motivée et rapide (SLA).
- **Art. 21** (règlement extrajudiciaire) : il est mentionné dans chaque décision et chaque rejet d’appel.
- **Art. 23** (mesures contre les utilisations abusives) : la suspension doit rester temporaire et précédée d’un avertissement quand l’abus n’est pas manifeste. L’échelle avertissement → restriction → suspension → bannissement est faite pour cela.
- **Art. 24(5)** (base de données de transparence de la Commission) : obligation à vérifier selon la taille de l’opérateur, l’art. 19 exemptant les micro et petites entreprises. Les données nécessaires sont présentes (motif, fondement, automatisation, capacités, dates), mais la **transmission n’est pas automatisée** (voir les limites).

## Administration (`/api/trust/admin/*`)

Toutes les routes exigent `requireAdmin`. Toutes les mutations sont auditées (`audit_events`, actions `trust.*`), comme la consultation des données de risque d’un membre (`trust.user.viewed`).

| Méthode et route | Usage |
| --- | --- |
| `GET /users?q=&role=&status=&risk=&limit=&offset=` | Liste paginée : vérification de l’e-mail, nombre de sanctions, niveau de risque |
| `GET /users/:id` | Profil, signaux (par type et empreintes distinctes), comptes liés par empreinte partagée, dossiers, sanctions, appels, sessions actives |
| `PATCH /users/:id/role` `{role}` | Changement de rôle. L’auto-rétrogradation est refusée, au moins un administrateur doit rester, et un compte suspendu ou banni ne peut pas devenir administrateur. |
| `POST /users/:id/sanctions` | Nouvelle sanction (`kind`, `capabilities`, `public_reason`, `internal_note`, `ground`, `ends_at` ou `duration_days`, `appealable`, `confirm_admin`) |
| `POST /users/:id/sessions/revoke` | Déconnexion de toutes les sessions |
| `POST /users/:id/cases` `{summary, score}` | Ouverture d’un dossier manuel |
| `GET /sanctions?active=&kind=` | Sanctions |
| `POST /sanctions/:id/revoke` `{reason}` | Levée d’une sanction ; les appels en cours sont clos |
| `GET /cases?status=&kind=&user_id=&assigned=` | File des dossiers |
| `POST /cases/:id/assign` `{assignee_id?}` | Prise en charge ou libération d’un dossier |
| `POST /cases/:id/dismiss` `{note}` | Classement sans suite, qui lève les retenues automatiques |
| `POST /cases/:id/action` | Sanction d’un membre du dossier |
| `GET /appeals?status=` | File des appels, avec SLA et retards |
| `POST /appeals/:id/accept` `{note?}` | Acceptation d’un appel |
| `POST /appeals/:id/reject` `{note}` | Rejet motivé d’un appel |
| `GET /stats` | Indicateurs |
| `GET`, `PUT /settings` | Seuils, mesures automatiques, conservation, appels |
| `POST /detect` | Lancement immédiat de `trust.detect` |

**API membre** :

- `GET /api/trust/me/restrictions` ;
- `GET /api/trust/appeals` ;
- `POST /api/trust/appeals` `{sanction_id, statement}`.

**Interfaces** :

- `UsersAdmin` (membres) ;
- `RiskAdmin` (dossiers, signaux, réglages) ;
- `AppealsAdmin` (appels) ;
- la section « Mes restrictions & appels » de la page Confiance.

## Litiges et séquestre

Lors de la clôture du dernier signalement d’une commande en litige :

- **Commande en mode démo** : comportement V3 inchangé. La commande reprend à l’état `paid` ou `delivered`, et `refunded` est refusé (400).
- **Commande `sandbox` ou `live`** (`orderPaymentMode`) : la résolution `refunded` appelle `refundOrderEscrow(orderId, admin.id, décision)` **dans la transaction de la décision**. En cas d’échec du prestataire de paiement, tout est annulé : le signalement reste ouvert et la commande reste en litige. En cas de succès :
  - la commande passe à `refunded` ;
  - un événement de commande est ajouté. Comme le CHECK de `order_events` ne connaît pas encore `refunded`, c’est un événement `resumed` horodaté et attribué à l’administrateur ;
  - les deux parties sont notifiées.
- Un règlement déjà enregistré (vente ou remboursement) bloque la résolution (409).

## Paramètres

| Clé | Contenu |
| --- | --- |
| `trust.thresholds` | Seuils des détecteurs (tableau ci-dessus) et `dismissed_cooldown_days` = 30 |
| `trust.auto_actions` | `hold_withdrawals_on_high_risk` = false, `hold_days` = 14 |
| `trust.retention` | `dismissed_cases_days` = 365, `sanctions_years` = 5 |
| `trust.appeals` | `sla_days` = 7, `window_days` = 180 |
| `privacy.retention.risk_signals_days` | 180 (propriété du module vie privée, lu par `trust.purge`) |

## Tâches planifiées

| Tâche | Fréquence | Rôle |
| --- | --- | --- |
| `trust.detect` | 10 min | Tous les détecteurs, puis les retenues automatiques si elles sont activées |
| `trust.purge` | quotidienne | Purge des signaux, des dossiers clos anciens, et des sanctions archivées avec leurs appels |

## Limites connues

- **Faux positifs** :
  - un appareil familial partagé ;
  - un ordinateur de bibliothèque ;
  - un réseau d’école ou d’entreprise sortant par une seule IP publique ;
  - une box partagée par des colocataires.

  Les scores restent donc modérés (50 à 75), aucune sanction n’est automatique, et l’administration rappelle que « réseau partagé » ne signifie pas « même personne ».
- **VPN, Tor, relais privés** : ils masquent les rapprochements par IP et peuvent créer des collisions entre inconnus. Les IP privées et CGNAT sont exclues, mais pas les sorties VPN publiques.
- **Identifiant d’appareil** : il est contrôlé par le client. Il est perdu en navigation privée ou après effacement du `localStorage`, et absent pour les clients non web. Un fraudeur peut le changer. Le forger pour viser un tiers suppose de connaître son UUID aléatoire, qui n’est jamais exposé.
- **Heuristiques simples** : les détecteurs sont des agrégats SQL, sans apprentissage automatique. Les cercles d’avis ne voient que les avis rattachés à des missions.
- **Rotation de la clé HMAC** : les empreintes antérieures ne se rapprochent plus des nouvelles.
- **Résumé de la dernière détection** (`lastDetection`) : il est conservé en mémoire du processus. L’historique durable se trouve dans `job_runs`.
- **Erreurs levées par les modules** : l’objet `restriction` d’une `RestrictionError` levée dans un module n’est pas encore renvoyé par le gestionnaire d’erreurs commun (seul `error` l’est). Le middleware, lui, renvoie bien `{error, restriction}`.
- **Base de transparence DSA** : la transmission des exposés des motifs (art. 24(5)) n’est pas automatisée.
