# Temps réel et notifications (V4)

Ce module apporte quatre choses :

- un flux d’événements en direct dans le navigateur ;
- des préférences de notification par catégorie et par canal (Alpha, e-mail, push) ;
- un résumé quotidien par e-mail ;
- les notifications Web Push, avec une console d’administration pour les e-mails et le push.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/009-realtime.sql` |
| API membre | `server/modules/realtime.ts` (`/api/realtime/*`) |
| Hub SSE | `server/realtime/sse.ts` |
| Hooks de notification | `server/realtime/hooks.ts` (`onNotification('realtime', …)`) |
| Catégories et préférences | `server/realtime/categories.ts`, `server/realtime/preferences.ts` |
| E-mail et résumé | `server/realtime/email.ts` (job `realtime.digest`) |
| Web Push | `server/realtime/push.ts` (job `push.deliver`) |
| Interrupteurs et réglages | `server/realtime/channels.ts` |
| API d’administration | `server/realtime/admin.ts` (`/api/realtime/admin/*`) |
| Messagerie | `server/modules/communication.ts` (événements `message.created`, `conversation.read`, accusés de lecture) |
| Client | `src/lib/realtime.tsx`, `src/pages/MessagesPage.tsx`, `src/components/NotificationPreferences.tsx`, `src/admin/EmailAdmin.tsx`, `src/styles/realtime.css` |
| Navigateur | `public/sw.js` (service worker push), `public/manifest.webmanifest` |
| Tests | `tests/realtime-v4.test.ts` |

## Architecture

### Pourquoi SSE plutôt que WebSocket

Le flux temps réel utilise **Server-Sent Events** (`GET /api/realtime/stream`), pas WebSocket :

- **Le trafic est presque entièrement descendant** (notifications, nouveaux messages, accusés de lecture, saisie en cours). Les rares actions montantes, comme envoyer un message, marquer comme lu ou signaler la saisie, passent par l’API REST existante. Elles profitent ainsi de ses protections : validation zod, CSRF (`X-Alpha-Client` + `Origin`), limites de débit, capacités et transactions.
- **Le flux réutilise le cookie de session HttpOnly et le middleware `attachUser`.** Il n’y a ni ticket ni jeton à transmettre dans l’URL, et la CSP reste `connect-src 'self'`.
- **Le navigateur se reconnecte tout seul** (`retry:`), et le protocole est du HTTP ordinaire. Il passe donc par les proxys, la compression désactivée et HTTP/2 sans module supplémentaire, sans dépendance `ws` ni gestion d’upgrade dans Express.
- **Le client garde la main sur la reconnexion.** `src/lib/realtime.tsx` applique un backoff exponentiel avec jitter (1 s → 60 s). Il rafraîchit la session après deux échecs, ferme le flux après 2 minutes en arrière-plan et le rouvre au retour sur l’onglet. Sans `EventSource`, il interroge le serveur toutes les 60 s.

Le passage à WebSocket ne serait utile que pour un usage bidirectionnel à haute fréquence, comme l’édition collaborative ou la présence fine. Ce n’est pas le cas aujourd’hui.

### Cycle de vie d’un événement

1. Une action métier appelle `notify()` (`server/core.ts`) dans une transaction.
2. Les hooks `onNotification` s’exécutent **dans la même transaction**. Le hook `realtime` :
   - calcule le nombre de notifications non lues et publie `notification.created` via `publishToUser` ;
   - met un e-mail en file (`email_outbox`) si les conditions sont remplies ;
   - met un push en file (`push_outbox`) pour chaque appareil abonné, si la préférence est active.
3. `publishToUser` est **différé après le commit** et abandonné en cas de rollback : aucun événement n’est émis pour une action annulée.
4. `subscribeUserEvents` (`server/platform/events.ts`) remet l’événement au hub SSE, qui l’écrit sur toutes les connexions ouvertes **de cet utilisateur uniquement**.

La messagerie suit le même principe : `message.created` et `conversation.read` sont publiés pour chaque participant de la conversation, et seulement pour eux.

### Limite : un seul nœud

Le hub SSE et le bus `publishToUser` vivent **en mémoire, dans un seul processus Node**. Il en va de même pour le limiteur de débit des signaux de saisie. Avec plusieurs instances derrière un équilibreur de charge, un utilisateur connecté à l’instance A ne recevrait pas les événements produits sur l’instance B.

Pour passer à l’échelle plus tard :

1. **Garder `publishToUser` comme unique point d’émission.** Ajouter un adaptateur qui publie après commit sur Redis (`PUBLISH alpha:user:<id> <json>`), ou sur PostgreSQL `LISTEN/NOTIFY` si la base migre vers Postgres.
2. **Sur chaque instance, s’abonner à ce canal**, avec un motif (`PSUBSCRIBE alpha:user:*`) ou un canal unique partitionné, puis appeler le dispatch local du hub SSE. Le hub n’a pas besoin de changer.
3. **Partager l’état transitoire.** Le compteur de connexions par utilisateur passe dans un `HINCRBY` Redis avec TTL, et la limitation de la saisie dans un `SET NX PX`.
4. **Désactiver l’affinité de session.** Elle n’est pas nécessaire, car chaque reconnexion SSE peut atterrir sur n’importe quelle instance.

Les jobs (`push.deliver`, `realtime.digest`, `mail.deliver`) prennent déjà leurs lots via des transitions de statut en base. Ils doivent toutefois s’exécuter sur **une seule instance** (`ALPHA_JOBS=off` sur les autres) tant que la base reste SQLite.

## Flux SSE

`GET /api/realtime/stream` exige un membre connecté. Ses caractéristiques :

- **Réponse.** `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, `retry: 5000`.
- **Événement initial.** `ready` `{ unread, heartbeat_ms }`.
- **Heartbeat.** Un commentaire `: ping` toutes les 25 s. À chaque heartbeat, **la session est revalidée** avec le cookie d’origine, via le même `attachUser` que l’API. Si la session est révoquée ou expirée, ou si le compte est suspendu, le serveur envoie `session.expired` puis ferme le flux. Tout événement d’audit visant l’utilisateur (révocation de session, changement de mot de passe, sanction…) déclenche aussi une revalidation immédiate.
- **Limites.**
  - 5 connexions simultanées par utilisateur ; au-delà, réponse `429` avec `Retry-After: 30`.
  - 30 ouvertures par minute et par utilisateur.
  - Une connexion dure au plus 30 minutes, puis le navigateur se reconnecte, ce qui revalide aussi les droits.
  - Au-delà de 1 Mo en tampon, un client lent est déconnecté.
- **Nettoyage.** À la fermeture, les timers sont arrêtés et la connexion est retirée du hub. `closeAllStreams()` sert à l’arrêt du serveur.

Événements émis :

| Événement | Données | Destinataires |
| --- | --- | --- |
| `ready` | `{ unread, heartbeat_ms }` | la connexion qui s’ouvre |
| `notification.created` | `{ id, kind, category, title, body, link, unread, created_at }` | le destinataire de la notification |
| `notification.read` | `{ unread }` | l’utilisateur (tous ses onglets) |
| `message.created` | `{ conversation_id, message, sender, conversation? }` | les autres participants de la conversation |
| `conversation.read` | `{ conversation_id, user_id, read_at }` | les participants de la conversation |
| `typing` | `{ conversation_id, user_id, name }` | les autres participants de la conversation |
| `session.expired` | `{ reason }` | la connexion concernée, juste avant la fermeture |

`link` est toujours un chemin interne relatif. Tout autre lien est remplacé par `/notifications`.

## API membre (`/api/realtime`)

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| GET | `/stream` | Flux SSE |
| GET | `/unread` | `{ unread }`, utilisé si le flux est indisponible |
| GET | `/preferences` | Catégories × canaux, fréquence e-mail, état de vérification de l’e-mail, interrupteurs globaux |
| PUT | `/preferences` | `{ categories?: { [catégorie]: { email?, push? } }, email_frequency?: 'immediate' \| 'daily', reset?: true }` |
| POST | `/typing` | `{ conversation_id }`, réservé aux participants. Limité à 40 requêtes par minute, avec au plus un événement toutes les 2,5 s par conversation |
| GET | `/push/public-key` | Clé publique VAPID, générée au premier appel |
| GET | `/push/subscriptions` | Appareils abonnés (hôte du service push, navigateur, date) |
| POST | `/push/subscriptions` | `{ endpoint, keys: { p256dh, auth } }`. 10 appareils au plus, 20 requêtes par heure |
| DELETE | `/push/subscriptions` | `{ endpoint }` : désabonne l’appareil courant |
| DELETE | `/push/subscriptions/:id` | Retire un appareil de la liste |

Messagerie (`/api/communication`) :

- `POST /conversations/:id/read` marque une conversation comme lue.
- La liste des conversations expose `unread_count`.
- Le fil d’une conversation expose `reads`, c’est-à-dire les dates de lecture de chaque participant.

## Préférences

Chaque `kind` passé à `notify()` est associé à une catégorie par `categoryForKind`, qui combine des correspondances exactes et des préfixes. Un `kind` inconnu tombe dans `account`.

| Catégorie | Exemples de `kind` | E-mail par défaut | Push par défaut | Contenu privé |
| --- | --- | --- | --- | --- |
| `testing` | `application`, `mission`, `report`, `sandbox.*` | oui | oui | non |
| `marketplace` | `order`, `marketplace.*` | non | oui | non |
| `payments` | `payment`, `withdrawal`, `kyc`, `wallet.*` | oui | oui | oui |
| `community` | `review`, `community.*` | non | non | non |
| `network` | `follow`, `organization`, `task_assignment` | non | non | non |
| `messages` | `message` | non | oui | oui |
| `trust` | `moderation`, `dispute`, `appeal` | oui | oui | oui |
| `account` | `security`, `account.*`, `privacy.*`, `integrations.*` | oui | oui | oui |

Fonctionnement :

- **Canal Alpha.** Il est toujours actif : les notifications restent consultables dans l’application.
- **Stockage.** Seuls les écarts aux valeurs par défaut sont enregistrés (`notification_preferences`). Une nouvelle catégorie n’exige donc aucune migration.
- **Contenu privé.** Pour ces catégories, le texte de la notification n’est **jamais copié** dans un e-mail ni dans un push : seul un titre générique et un lien sont envoyés.

## Canal e-mail

Un e-mail de notification est mis en file **dans la transaction de la notification** seulement si toutes ces conditions sont réunies :

1. l’interrupteur global `mail.notifications.enabled` est actif ;
2. le membre a activé l’e-mail pour la catégorie ;
3. `users.email_verified_at` n’est pas nul (colonne ajoutée par la migration 005) ;
4. la fréquence est `immediate`. Pour la catégorie `account`, l’envoi est toujours immédiat ;
5. aucun e-mail identique n’attend déjà dans la file ;
6. le membre a reçu moins de 20 e-mails de notification dans l’heure glissante.

Le rendu passe par `renderEmail` (`server/platform/mailer.ts`) avec un bouton vers le lien de la notification. L’envoi lui-même est assuré par le job `mail.deliver` de la plateforme.

**Résumé quotidien.** Avec la fréquence `daily`, le job horaire `realtime.digest` envoie au plus un e-mail toutes les 24 h, avec une tolérance de 30 min. Il regroupe jusqu’à 25 notifications non lues des catégories où l’e-mail est activé.

## Web Push

- **Clés VAPID.** Elles sont générées au premier usage avec `generateVAPIDKeys` de `web-push`. La clé privée est **scellée** (AES-256-GCM, `server/platform/secrets.ts`) dans le réglage `push.vapid`. Un administrateur peut renouveler les clés ; les abonnements existants sont alors supprimés et les navigateurs doivent se réabonner.
- **Sujet VAPID.** Il vient du réglage `push.config.subject`, sinon de `APP_ORIGIN` si l’origine est en `https://`, sinon de `mailto:notifications@alpha.local`.
- **Garde SSRF.** L’URL d’abonnement doit être en `https://`, sans identifiants, port explicite ni fragment, et son hôte doit figurer dans la liste blanche :
  - `fcm.googleapis.com` ;
  - `*.push.services.mozilla.com` ;
  - `*.notify.windows.com` ;
  - `web.push.apple.com` ;
  - `*.push.apple.com`.

  Cette vérification est refaite au moment de l’envoi.
- **Stockage.** L’URL et les clés de l’abonnement sont scellées. En clair, la base ne garde qu’un hash, pour l’unicité, et l’hôte, pour le diagnostic.
- **Envoi.** Le job `push.deliver` tourne toutes les 10 s, par lots. Les messages ont un TTL configurable (24 h par défaut, 28 jours au plus) et un payload minimal `{ title, body, link, tag }`.
- **Échecs.**
  - `404` ou `410` : l’abonnement est supprimé.
  - `400`, `403` ou `413` : échec définitif.
  - Autres erreurs : nouvel essai avec un backoff exponentiel (30 s → 1 h), 5 tentatives au plus.
- **Tests.** L’expéditeur est injectable avec `setPushSenderForTests()`, ce qui permet de les écrire sans réseau.
- **Service worker** (`public/sw.js`).
  - À la réception d’un push, il appelle `showNotification`, avec l’icône `/favicon.svg` et le lien dans `data.url`.
  - Au clic, il met au premier plan un onglet Alpha existant ou ouvre une URL **de la même origine uniquement**.
  - Lors d’un `pushsubscriptionchange`, il réabonne le navigateur.
  - Il ne met rien en cache hors ligne.

## Console d’administration (`/admin/email`)

Toutes les routes `/api/realtime/admin/*` exigent le rôle admin et chaque modification est auditée. La console regroupe :

- **SMTP.**
  - Le formulaire couvre l’hôte, le port, TLS implicite, l’identifiant et l’expéditeur, et enregistre dans `mail.smtp`.
  - Le mot de passe est stocké en secret scellé (`mail.smtp.password`) et **n’est jamais renvoyé** : l’API ne retourne qu’un masque `••••••••`.
  - Si la variable `SMTP_URL` est définie, elle a priorité sur ce formulaire.
- **E-mail de test.** Il est limité à 5 envois par tranche de 10 minutes et passe immédiatement par `mail.deliver`.
- **File d’envoi.**
  - Filtres par statut, catégorie et recherche.
  - Relance des envois échoués, annulation des envois en file.
  - Le contenu des e-mails sensibles (vérification, réinitialisation, paiements, messages…) n’est jamais affiché, et chaque consultation d’un contenu est auditée.
- **Push.** Clé publique, statistiques, hôtes, échecs récents, sujet, TTL et renouvellement des clés.
- **Interrupteurs globaux.** `mail.notifications` coupe les e-mails de notification et les résumés, mais pas les e-mails transactionnels. `push.config.enabled` coupe le push.

## Configuration

| Réglage (table `platform_settings`) | Contenu |
| --- | --- |
| `mail.smtp` | `{ host, port, secure, user, from }` |
| `mail.smtp.password` | secret scellé |
| `mail.notifications` | `{ enabled }` : interrupteur global des e-mails de notification |
| `push.config` | `{ enabled, subject, ttl_seconds }` : interrupteur global et paramètres du push |
| `push.vapid` | `{ public_key, created_at }` et clé privée scellée |

| Variable d’environnement | Effet |
| --- | --- |
| `APP_ORIGIN` | origine publique, utilisée pour les liens des e-mails et le sujet VAPID par défaut |
| `SMTP_URL` | transport SMTP prioritaire sur la configuration de la console |
| `MAIL_FROM` | adresse d’expédition forcée |
| `ALPHA_JOBS=off` | désactive les jobs (`push.deliver`, `realtime.digest`…) sur une instance |

| Job | Fréquence | Rôle |
| --- | --- | --- |
| `push.deliver` | 10 s | Envoie la file `push_outbox` (actif seulement si le push est activé) |
| `realtime.digest` | 1 h | Résumés quotidiens des membres en fréquence `daily` |

## Déploiement derrière un proxy

- **nginx.** Utiliser `proxy_buffering off;` (l’en-tête `X-Accel-Buffering: no` le fait déjà par réponse), `proxy_read_timeout 60s;` (plus que le heartbeat de 25 s) et `proxy_http_version 1.1;`. Désactiver gzip sur `text/event-stream` si un module le force.
- **HTTP/2.** Il est recommandé. En HTTP/1.1, les navigateurs limitent à 6 connexions par domaine, ce qui se fait vite sentir avec plusieurs onglets ouverts.
- **Service worker.** `/sw.js` doit être servi avec `Cache-Control: no-cache` pour que les mises à jour soient prises en compte rapidement.
- **Arrêt propre.** Appeler `closeAllStreams()` avant `server.close()`. Sinon, les connexions SSE maintiennent le serveur ouvert jusqu’au délai d’arrêt.

## Données personnelles

`registerPersonalData('realtime', …)` couvre :

- **Export.** Préférences, fréquence, appareils push (hôte, navigateur, dates, mais pas l’URL scellée) et accusés de lecture.
- **Suppression.** Préférences, réglages, abonnements, file push et accusés de lecture.

L’activation du push repose toujours sur une action explicite du membre : bouton « Activer les notifications push » puis autorisation du navigateur. Le membre peut la retirer appareil par appareil.

## Limites connues

- **Un seul nœud.** Le hub SSE, la limitation de la saisie et le compteur de connexions sont en mémoire (voir « Limite : un seul nœud »).
- **Pas de rattrapage après déconnexion.** Les événements ne sont pas rejoués via `Last-Event-ID`. Après une reconnexion, l’événement `ready` resynchronise le compteur de non-lus ; les listes affichées se mettent à jour au prochain chargement.
- **Push au mieux.** L’envoi dépend du service push du navigateur. Sur iOS, il faut installer Alpha sur l’écran d’accueil (Safari 16.4 ou plus récent).
- **Résumé quotidien approximatif.** L’envoi se fait à l’heure près, selon la planification horaire du job.
- **Pas d’accès hors ligne.** Le service worker ne gère aucun cache.
