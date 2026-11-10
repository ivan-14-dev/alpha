# Intégrations GitHub, GitLab, Figma et webhooks (V4)

Le module relie les projets Alpha aux outils des équipes, dans les deux sens.

- **Comptes connectés.** Chaque membre peut connecter son compte GitHub, GitLab (gitlab.com ou une instance auto-hébergée) ou Figma par OAuth. Cela lui permet de choisir un dépôt ou un fichier dans une liste et de laisser Alpha créer le webhook chez le fournisseur.
- **Sources de projet (webhooks entrants).** Un dépôt ou un fichier lié à un projet envoie ses événements à Alpha : push sur la branche par défaut, releases, tags, nouvelles versions et commentaires Figma. La signature de chaque requête est vérifiée. Les événements apparaissent dans la page Intégrations, et Alpha prévient le responsable du projet et les testeurs des campagnes en cours (« Nouvelle version disponible : v1.2.0 »).
- **Webhooks sortants.** Le responsable d’un projet peut recevoir les événements de ce projet (campagnes, candidatures, missions, rapports, marketplace, sources…) sur ses propres URL. Chaque requête est signée en HMAC-SHA256, avec nouvelles tentatives, journal, renvoi et protection SSRF.

Les fonctions V3 sont conservées : liens d’outils par projet (GitHub, GitLab, Linear, Figma) et export JSON des campagnes, missions et rapports.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/011-integrations.sql` |
| Assemblage des routes et API V3 | `server/modules/integrations.ts` (`/api/integrations/*`) |
| Fournisseurs (OAuth, API, webhooks distants) | `server/integrations/providers.ts`, `server/integrations/http.ts` (`fetch` injectable) |
| OAuth et comptes connectés | `server/integrations/oauth.ts`, `server/integrations/connections.ts` |
| Sources de projet | `server/integrations/sources.ts` |
| Réception des webhooks entrants | `server/integrations/inbound.ts` |
| Webhooks sortants | `server/integrations/catalog.ts` (catalogue, projet ciblé, contenu), `server/integrations/outgoing.ts` (file, signature, jobs), `server/integrations/endpoints.ts` (API) |
| Protection SSRF | `server/integrations/ssrf.ts` |
| Administration | `server/integrations/admin.ts` (`/api/integrations/admin/*`), `src/admin/IntegrationsAdmin.tsx` |
| Données personnelles | `server/integrations/privacy.ts` |
| Client | `src/pages/IntegrationsPage.tsx`, `src/styles/integrations.css` |
| Tests | `tests/integrations-v4.test.ts` (fournisseurs simulés, récepteur HTTP local) ; `tests/platform.test.ts` couvre les fonctions V3 |

## Configuration

### Variables d’environnement

| Variable | Rôle |
| --- | --- |
| `APP_ORIGIN` | Origine publique de l’application (obligatoire en production). Les URL de rappel OAuth en dérivent : `${APP_ORIGIN}/api/integrations/oauth/<fournisseur>/callback`. |
| `PUBLIC_API_ORIGIN` | Origine joignable depuis Internet, utilisée pour les URL de réception des webhooks entrants : `${PUBLIC_API_ORIGIN}/api/integrations/webhooks/<fournisseur>/<source>`. Par défaut, c’est `APP_ORIGIN`. GitHub, GitLab et Figma exigent une URL publique, et en pratique HTTPS. |
| `ALPHA_SECRETS_KEY` (+ `ALPHA_SECRETS_KEY_PREVIOUS`) | Clé de chiffrement des jetons OAuth, des secrets clients et des secrets de webhook (voir la plateforme). Elle est obligatoire en production. |
| `NODE_ENV` | En `production`, les webhooks sortants exigent HTTPS sur les ports 443 et 8443, et les surcharges de test sont refusées. |

Aucune autre variable n’est nécessaire : les applications OAuth se configurent dans l’administration.

### Administration (`/admin/integrations`)

L’onglet **Applications OAuth** présente un formulaire par fournisseur. Le réglage `integrations.<fournisseur>` contient :

```json
{ "enabled": true, "client_id": "…", "base_url": "https://gitlab.com", "scopes": ["read_api", "read_user"], "private_scopes": ["repo"] }
```

- **`client_secret`** est enregistré comme secret chiffré (`integrations.<fournisseur>.client_secret`). Il n’est jamais réaffiché ; seul un aperçu masqué (`gh-••••cdef`) est visible. Laissez le champ vide pour garder la valeur actuelle, ou cochez « Supprimer le secret enregistré ».
- **Activation.** Un fournisseur ne peut être activé qu’avec un identifiant client et un secret.
- **`base_url`** n’existe que pour GitLab (HTTPS ; HTTP seulement hors production). Changer d’instance oblige les membres à se reconnecter.
- **`private_scopes`** n’existe que pour GitHub. Ce sont les scopes ajoutés quand le membre coche « Inclure les dépôts privés ». Laissez la liste vide pour désactiver cette option.
- **URL de rappel.** Chaque formulaire affiche l’URL de rappel à copier chez le fournisseur.

Le réglage `integrations.webhooks` vaut `{ "enabled": true, "max_endpoints_per_project": 10 }` (maximum : 1 à 50 webhooks par projet). La désactivation bloque la création de nouveaux webhooks sortants ; ceux qui existent déjà continuent de recevoir les événements.

Les autres onglets :

- **Statistiques** : comptes, sources, webhooks actifs et désactivés, livraisons sur 24 h et 7 j, événements reçus.
- **Livraisons sortantes** : filtre par statut, abandonnées par défaut ; renvoi possible.
- **Événements entrants** : filtre par fournisseur et par statut.

Les URL y sont affichées sans leur chaîne de requête.

### Créer les applications OAuth

#### GitHub (OAuth App)

1. Ouvrez GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**. Pour une organisation, passez par les paramètres de l’organisation.
2. Remplissez **Homepage URL** avec `APP_ORIGIN` et **Authorization callback URL** avec `https://alpha.exemple.fr/api/integrations/oauth/github/callback`.
3. Générez un **client secret**, puis collez l’identifiant et le secret dans l’administration Alpha.
4. Scopes :
   - Par défaut : `read:user` (profil) et `admin:repo_hook` (créer et supprimer les webhooks des dépôts administrés par le membre).
   - Avec « Inclure les dépôts privés », Alpha ajoute `repo`. Les scopes d’une OAuth App sont larges : `repo` donne l’accès complet aux dépôts privés.
   - Sans `repo`, seuls les dépôts publics sont listés.
   - Pour une démarche en lecture seule, retirez `admin:repo_hook` : les webhooks seront alors à configurer manuellement.
5. Le flux utilise `state` et PKCE (S256). GitHub ne permet pas de limiter les dépôts accessibles à une OAuth App : pour un contrôle par dépôt, prévoyez une GitHub App (hors périmètre V4).

#### GitLab (gitlab.com ou auto-hébergé)

1. Ouvrez GitLab → **Préférences** → **Applications**, ou **Admin** → **Applications** pour une application d’instance.
2. Choisissez une application **confidentielle**. Renseignez l’URL de rappel `https://alpha.exemple.fr/api/integrations/oauth/gitlab/callback` et les scopes `read_api` et `read_user`.
3. Pour la **création automatique des webhooks**, ajoutez le scope `api` dans GitLab **et** dans Alpha. Le membre doit aussi avoir le rôle *Maintainer* sur le projet. Sans `api`, Alpha affiche des instructions de configuration manuelle.
4. Pour une instance auto-hébergée, indiquez son URL HTTPS dans « URL de l’instance GitLab ».
5. Le flux utilise `state` et PKCE (S256). Les jetons GitLab expirent au bout de 2 h ; Alpha les renouvelle automatiquement avec le *refresh token*.

#### Figma

1. Ouvrez Figma → **Developers** → **My apps** → **Create app** → **OAuth credentials**.
2. Ajoutez l’URL de rappel `https://alpha.exemple.fr/api/integrations/oauth/figma/callback`.
3. Déclarez les scopes `current_user:read`, `file_content:read`, `file_metadata:read` et `webhooks:write`, puis publiez l’application. Une application non publiée ne fonctionne que pour son créateur.
4. Points d’accès utilisés : `https://www.figma.com/oauth` (autorisation), `https://api.figma.com/v1/oauth/token` (échange) et `https://api.figma.com/v1/oauth/refresh` (renouvellement). Figma ne propose pas PKCE ici : la protection repose sur un `state` lié à la session.
5. Figma n’offre **pas d’API de révocation**. À la déconnexion, Alpha supprime les jetons de son côté et invite le membre à retirer l’application dans ses paramètres Figma.

## Parcours membre (`/integrations`)

### Comptes connectés

1. **Lancement.** « Connecter GitHub » appelle `GET /api/integrations/oauth/github/start?access=public|private&return_to=/integrations`.
   - Alpha crée un `state` aléatoire, dont seule l’empreinte est stockée. Il est lié à l’utilisateur connecté, valable 10 minutes et à usage unique. Alpha génère aussi un vérificateur PKCE, chiffré au repos.
   - Le client reçoit l’`authorize_url` quand la requête porte `X-Alpha-Client: web` ; sinon, la réponse est une redirection 302.
2. **Retour.** Au retour, `GET …/callback` vérifie trois points : le `state` est valide et non expiré, il appartient au **même utilisateur de session**, et le fournisseur correspond.
   - Alpha échange ensuite le code et lit l’identité du compte, puis enregistre les jetons **chiffrés** (`seal`, contexte lié à la connexion).
   - La redirection finale est toujours **relative** (`return_to` doit commencer par `/` ; `//` et `\` sont refusés), avec `?connected=<fournisseur>` ou `?integration_error=session|state|denied|exchange|disabled`.
3. **Unicité.** Un membre a au plus une connexion active par fournisseur et par instance : se reconnecter remplace les jetons de la connexion existante.
4. **Déconnexion.** `DELETE /api/integrations/connections/:id` supprime les jetons et tente la révocation :
   - GitHub : `DELETE /applications/{client_id}/token` ;
   - GitLab : `POST /oauth/revoke` ;
   - Figma : aucune API, donc pas de révocation par Alpha.

   La réponse indique si la révocation a réussi. Les webhooks déjà créés continuent de fonctionner, car ils sont authentifiés par leur propre secret.

### Sources d’un projet (onglet « Sources »)

Réservé aux personnes qui gèrent le projet (`canManageProject` : propriétaire, ou propriétaire/admin de l’organisation).

1. **Choisir la source.**
   - Avec un compte connecté, choisissez dans la liste paginée de vos dépôts GitHub ou projets GitLab (avec recherche), ou saisissez `propriétaire/nom`, une URL ou un identifiant numérique. Pour Figma, saisissez le lien ou la clé du fichier.
   - Sans compte connecté, saisissez `propriétaire/nom` (GitHub/GitLab) ou la clé du fichier Figma.
2. **Liaison.** Alpha génère un **secret de webhook** (32 octets aléatoires, chiffré au repos) puis :
   - **en mode automatique** (compte connecté, option manuelle non cochée), il crée le webhook chez le fournisseur :
     - GitHub : `POST /repos/{o}/{r}/hooks`, événements `push` et `release`, `content_type: json`, avec le secret ;
     - GitLab : `POST /projects/:id/hooks`, avec `push_events`, `tag_push_events`, `releases_events`, `token` et la vérification SSL activée ;
     - Figma : `POST /v2/webhooks` (contexte `file`), un webhook par type d’événement (`FILE_VERSION_UPDATE` et `FILE_COMMENT`), avec `passcode`.
   - **sinon**, ou si le fournisseur refuse (droits insuffisants, URL non publique), il passe en **mode manuel** : l’URL de réception, le secret et les instructions pas à pas sont **affichés une seule fois**. Le membre peut régénérer le secret plus tard (« Nouveau secret », sources manuelles uniquement).
3. **Déliaison.** « Délier » supprime la source et tente de supprimer le webhook chez le fournisseur, sans garantie.
4. **Suivi.** Les **événements reçus récemment** (date, source, type, résumé, statut) s’affichent sous la liste.

### Webhooks sortants (onglet « Webhooks sortants »)

Le responsable du projet peut :

- créer un webhook : URL, description, cases à cocher par événement ; le secret `whsec_…` n’est affiché qu’une fois ;
- l’envoyer en test (`ping`), le modifier, le désactiver ou le réactiver, le supprimer ;
- régénérer le secret : l’ancien reste valable **24 h** et chaque requête porte alors deux signatures `v1` ;
- consulter le journal des livraisons (filtre par statut, contenu exact envoyé) et renvoyer une livraison.

## Webhooks entrants

URL : `POST /api/integrations/webhooks/{github|gitlab|figma}/{sourceId}`.

- Elle ne demande pas de session et est exemptée du contrôle CSRF.
- Le corps est lu **brut** (`Buffer`, 2 Mo maximum) pour que la signature porte exactement sur les octets reçus.

| Fournisseur | Authentification (comparaison à temps constant) | Anti-rejeu / déduplication | Événements traités |
| --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256: sha256=HMAC-SHA256(secret, corps)` | `X-GitHub-Delivery` (unique par fournisseur) | `ping` ; `push` sur la branche par défaut (les branches supprimées et les autres branches sont ignorées) ; `release` avec `action = published` |
| GitLab | `X-Gitlab-Token` = secret | `X-Gitlab-Event-UUID` (à défaut `Idempotency-Key`, puis empreinte du corps) | `Push Hook` (branche par défaut), `Tag Push Hook`, `Release Hook` (`action = create`) |
| Figma | `passcode` dans le corps JSON = secret | Empreinte de `webhook_id`, `event_type`, `timestamp`, `version_id`/`comment_id` | `PING`, `FILE_VERSION_UPDATE`, `FILE_COMMENT` (le `file_key` doit correspondre à la source) |

Réponses :

- **200** : `{ "received": true, "status": "processed" | "ignored" | "failed" }`, ou `{ "received": true, "duplicate": true }` pour un renvoi déjà traité.
- **401** `{"error":"Non autorisé."}` : source inconnue, fournisseur différent ou signature invalide. La réponse ne dit jamais lequel de ces cas s’applique.
- **400** : corps illisible.
- **429** : limite de débit atteinte.

Le traitement est synchrone et court ; il ne fait aucun appel réseau.

Effets :

- Chaque événement authentifié est enregistré dans `integration_inbound_events`, avec un résumé lisible : « Push sur main : 2 commits par ines — b2c3d4e Corrige… ». Les tables d’activité de projet de la V3 restant inchangées, les résumés sont affichés dans l’onglet Sources et dans l’administration.
- **Nouvelle version** (release GitHub, tag ou release GitLab, version Figma) :
  - notification `testing.release` « Nouvelle version disponible : v1.2.0 » au propriétaire du projet et aux testeurs ayant une mission active sur une campagne ouverte du projet ;
  - même version annoncée une seule fois par 24 h, et au plus 3 annonces par heure et par source ;
  - événement sortant `source.release`.
- **Push sur la branche par défaut** : notification `integrations.activity` au propriétaire (au plus une toutes les 30 min par source) et événement sortant `source.push`.
- **Commentaire Figma** : notification `integrations.activity` au propriétaire (au plus une toutes les 30 min par source).

## Webhooks sortants

### Production des événements

- **Abonnement.** Le module s’abonne à `onDomainEvent('integrations.webhooks', …)`. Chaque action auditée (`audit(...)`) est convertie en type public ; les préfixes `demo.`, `sandbox.`, `live.` et `marketplace.` sont retirés, et `marketplace.purchased` devient `order.created`.
- **Projet concerné.** Alpha retrouve le projet de la cible (projet, tâche, campagne, candidature, mission, offre, commande).
- **Livraisons.** Le hook ne fait **qu’insérer** une ligne de livraison par webhook actif abonné, de façon synchrone et dans la transaction métier. L’envoi a lieu après validation de la transaction (job `integrations.deliver`).

### Format d’une requête

```http
POST /webhooks/alpha HTTP/1.1
Content-Type: application/json
User-Agent: Alpha-Webhooks/1.0
X-Alpha-Event: campaign.created
X-Alpha-Delivery: 7c0e…            (identifiant de la livraison ; change à chaque renvoi)
X-Alpha-Signature: t=1762743600,v1=5f1c…[,v1=… ancien secret pendant 24 h après rotation]

{"id":"evt_…","type":"campaign.created","created_at":"2026-11-10T03:00:00.000Z","data":{…}}
```

- `id` (`evt_…`) identifie l’**événement**. Il reste le même lors d’un renvoi : utilisez-le pour dédupliquer.
- La signature `v1` vaut `HMAC-SHA256(secret, t + "." + corps brut)`, en hexadécimal.
- Une réponse **2xx** vaut succès. Les redirections ne sont **pas suivies** et comptent comme un échec. Le délai maximal est de **10 s**.

### Vérifier une requête (Node.js)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const SECRET = process.env.ALPHA_WEBHOOK_SECRET; // whsec_…
const TOLERANCE_SECONDS = 300;
const seen = new Set(); // en production : stockage partagé avec expiration

function verify(rawBody, header) {
  const parts = String(header ?? '').split(',').map((part) => part.trim().split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isInteger(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex'));
  return signatures.some((signature) => {
    const candidate = Buffer.from(signature);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

const app = express();
app.post('/webhooks/alpha', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const rawBody = req.body.toString('utf8'); // corps EXACT, avant tout JSON.parse
  if (!verify(rawBody, req.get('X-Alpha-Signature'))) return res.status(401).end();
  const event = JSON.parse(rawBody);
  if (seen.has(event.id)) return res.status(200).end(); // déjà traité
  seen.add(event.id);
  res.status(200).end(); // répondez vite, traitez en arrière-plan
  queueMicrotask(() => handle(event));
});

function handle(event) {
  if (event.type === 'ping') return;
  console.log(event.type, event.data);
}
app.listen(8080);
```

Bonnes pratiques côté consommateur :

- vérifiez la signature sur le corps brut ;
- refusez les horodatages de plus de 5 minutes ;
- dédupliquez sur `id` ;
- répondez en moins de 10 s et traitez de façon asynchrone ;
- acceptez plusieurs `v1` pour couvrir la période de rotation.

### Catalogue des événements

| Type | Groupe | Contenu de `data` (en plus de `project_id`) |
| --- | --- | --- |
| `ping` | Test | `endpoint_id` |
| `project.updated` | Projet | `project { id, title, stage, visibility, updated_at }` |
| `task.created`, `task.updated` | Projet | `task { id, title, status, priority, assignee_id, due_at, updated_at }` |
| `campaign.created`, `campaign.funded` | Tests | `campaign { id, title, status, slots, deadline, reward_cents* }` |
| `application.created`, `application.accepted`, `application.rejected` | Tests | `campaign_id`, `application { id, campaign_id, tester_id, status, created_at }` |
| `mission.started`, `mission.changes_requested`, `mission.accepted`, `mission.disputed`, `mission.paid` | Tests | `campaign_id`, `mission { id, campaign_id, tester_id, status, updated_at }` |
| `report.submitted`, `report.revised` | Tests | `campaign_id`, `mission_id`, `report { id, updated_at }`, `mission` |
| `listing.created`, `listing.updated`, `listing.archived` | Marketplace | `listing { id, title, kind, status, price_cents* }` |
| `order.created`, `order.delivered`, `order.revision_requested`, `order.disputed`, `order.completed` | Marketplace | `listing_id`, `order { id, listing_id, status, created_at, price_cents* }` |
| `source.push` | Sources | `source { id, provider, full_name, url }`, `branch`, `commits`, `head_commit` |
| `source.release` | Sources | `source`, `version`, `name`, `prerelease`, `url` (et `version_id` pour Figma) |

\* Les montants (`reward_cents`, `price_cents`) ne figurent que si le propriétaire du webhook est aussi celui de la ressource (campagne, offre, vente).

Ne sont jamais envoyés : contenus de messages privés, e-mails, noms ou coordonnées, textes des rapports, détails de paiement, jetons ou secrets. Le consommateur relit les détails via l’interface Alpha s’il y a accès.

### Nouvelles tentatives, abandon et désactivation

| Situation | Comportement |
| --- | --- |
| Échec (réseau, délai, réponse non 2xx, redirection) | Nouvel essai après 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, puis 12 h, soit **8 tentatives** sur environ 22 h. Ensuite, la livraison passe au statut `dead`. |
| `ping` (test) | Une seule tentative, jamais retentée. |
| 20 échecs consécutifs sur un webhook | Le webhook est **désactivé automatiquement** (`disabled_reason`), et son propriétaire reçoit la notification `integrations.webhook`. |
| URL devenue non sûre (DNS vers une adresse privée…) | Aucune connexion n’est ouverte. La tentative compte comme un échec (« URL refusée : … ») et suit le calendrier normal des nouvelles tentatives. |
| Webhook désactivé | Les nouveaux événements ne sont pas mis en file. Les livraisons en attente reprennent à la réactivation ; au-delà de 3 jours, elles passent en `dead` (« Expiré »). |
| Renvoi (membre ou administrateur) | Nouvelle livraison (nouvel `X-Alpha-Delivery`, même `id` d’événement), une tentative immédiate. |

Le job `integrations.deliver` tourne toutes les 15 s et reprend les livraisons restées bloquées en `delivering`. Il est aussi déclenché juste après chaque transaction qui a mis des livraisons en file.

### Protection SSRF

Chaque URL est vérifiée à la création, à la modification **et avant chaque envoi** :

- **Schéma et port.** Le schéma doit être `https`. `http` n’est accepté que hors production. En production, seuls les ports 443, 80 et 8443 sont acceptés.
- **Hôte.** Les identifiants dans l’URL (`user:pass@`) et `localhost`/`*.localhost` sont refusés.
- **Résolution DNS.** Toutes les adresses du nom sont résolues (`dns.lookup(…, { all: true })`). La requête est refusée si **l’une d’elles** est non publique :
  - IPv4 : 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (dont 169.254.169.254, métadonnées cloud), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast), 240/4 et 255.255.255.255 ;
  - IPv6 : seules les adresses unicast globales (`2000::/3`) sont acceptées. Sont donc refusés `::`, `::1`, les adresses IPv4 mappées (`::ffff:a.b.c.d`) et NAT64 (`64:ff9b::/96`), `fc00::/7`, `fe80::/10` et `ff00::/8`. Dans `2000::/3`, Alpha refuse aussi `2001::/23`, `2001:db8::/32` (documentation), `2002::/16` (6to4) et `3fff::/20`.
- **Connexion.** La connexion se fait sur l’**adresse vérifiée**, par une résolution personnalisée : un changement DNS entre la vérification et l’envoi (*DNS rebinding*) est donc sans effet. Le SNI et l’en-tête `Host` gardent le nom d’origine.
- **Envoi.** Pas de proxy, pas de connexion réutilisée, pas de redirection suivie, délai de 10 s. Le corps de la réponse n’est pas lu : seul le code HTTP compte.

Les tests utilisent `allowWebhookAddressesForTests` et `setWebhookResolverForTests` (récepteur local). Ces surcharges lèvent une erreur en production.

## API

Toutes les routes sont sous `/api/integrations` et demandent une session, sauf indication contraire. Les requêtes autres que GET exigent `X-Alpha-Client: web` et une origine autorisée (CSRF), sauf pour les webhooks entrants.

### OAuth et comptes

| Méthode et route | Description |
| --- | --- |
| `GET /providers` | État des fournisseurs (activé, instance, option dépôts privés, connexion du membre) |
| `GET /oauth/:provider/start?access=public\|private&return_to=/…` | Démarre l’autorisation : JSON `{ authorize_url }` avec `X-Alpha-Client: web`, sinon redirection 302 |
| `GET /oauth/:provider/callback` | Retour du fournisseur. Sans session requise, mais le `state` doit appartenir à l’utilisateur connecté ; redirection relative |
| `GET /connections` | Comptes connectés du membre, sans jetons |
| `DELETE /connections/:id` | Déconnexion et révocation quand l’API existe : `{ disconnected, provider, revoked_at_provider, manual_revocation_required }` |
| `GET /github/repos?page=` | Dépôts du compte GitHub connecté (paginés) |
| `GET /gitlab/projects?page=&search=` | Projets GitLab du compte connecté (paginés, recherche) |

### Sources de projet

| Méthode et route | Description |
| --- | --- |
| `GET /projects/:projectId/sources` | Sources et derniers événements reçus |
| `POST /projects/:projectId/sources` | `{ provider, external_id? \| full_name? \| file_key?, manual? }` → `{ source, setup }`. En mode manuel, `setup` contient `url`, `secret` (une seule fois) et `instructions` |
| `POST /projects/:projectId/sources/:sourceId/rotate-secret` | Nouveau secret (sources manuelles uniquement) |
| `DELETE /projects/:projectId/sources/:sourceId` | Délie la source et supprime le webhook distant (sans garantie) |
| `GET /projects/:projectId/inbound-events?limit=` | Événements reçus pour le projet |
| `POST /webhooks/:provider/:sourceId` | **Réception** des webhooks (sans session ni CSRF, corps brut) |

### Webhooks sortants

| Méthode et route | Description |
| --- | --- |
| `GET /endpoints/catalog` | Catalogue des événements, format de signature, réglages |
| `GET /projects/:projectId/endpoints` | Webhooks du projet, sans secret |
| `POST /projects/:projectId/endpoints` | `{ url, description?, events[] }` → `{ endpoint, secret }` (secret affiché une seule fois) |
| `PATCH /endpoints/:id` | `{ url?, description?, events?, active? }`. La réactivation remet le compteur d’échecs à zéro |
| `DELETE /endpoints/:id` | Suppression (et de son journal) |
| `POST /endpoints/:id/rotate-secret` | `{ endpoint, secret, previous_secret_valid_until }` |
| `POST /endpoints/:id/test` | Envoie un `ping` synchrone : `{ ok, status, error, duration_ms, delivery }` |
| `GET /endpoints/:id/deliveries?status=&offset=` | Journal paginé (50 par page) |
| `GET /deliveries/:id` | Détail d’une livraison, avec le contenu envoyé |
| `POST /deliveries/:id/redeliver` | Renvoie une livraison terminée |

### Administration (rôle `admin`)

| Méthode et route | Description |
| --- | --- |
| `GET /admin/providers` | Configuration (secrets masqués) et URL de rappel |
| `PUT /admin/providers/:provider` | `{ enabled, client_id, base_url?, scopes?, private_scopes?, client_secret? }` (`null` supprime le secret) |
| `PUT /admin/webhooks` | `{ enabled, max_endpoints_per_project }` |
| `GET /admin/overview` | Statistiques et webhooks désactivés |
| `GET /admin/deliveries?status=dead&offset=` | Livraisons de toute l’instance (URL masquées, sans contenu) |
| `POST /admin/deliveries/:id/redeliver` | Renvoi, audité |
| `GET /admin/inbound?provider=&status=&offset=` | Journal des événements entrants |

### Fonctions V3 conservées

| Méthode et route | Description |
| --- | --- |
| `GET /projects?offset=` | Projets que le membre peut gérer |
| `GET /?project_id=` · `POST /` · `DELETE /:id` | Liens d’outils par projet |
| `GET /export?project_id=` | Export JSON du projet (campagnes, missions, rapports) |

## Modèle de données (migration 011)

| Table | Contenu |
| --- | --- |
| `integration_connections` | Membre, fournisseur, `base_url` (GitLab), identifiant et login externes, jetons d’accès et de rafraîchissement **chiffrés**, scopes, `expires_at`, `revoked_at`. Au plus une connexion active par membre, fournisseur et instance |
| `integration_oauth_states` | **Empreinte** du `state`, membre, fournisseur, vérificateur PKCE chiffré, scopes demandés, `return_to`, expiration à 10 min, `used_at` |
| `integration_project_sources` | Projet, fournisseur, identifiant et nom externes, URL, branche par défaut, secret de webhook **chiffré**, identifiant du webhook distant, mode `automatic\|manual`, connexion utilisée, auteur, `last_event_at` |
| `integration_inbound_events` | Fournisseur, `delivery_id` **unique par fournisseur**, type, source, projet, statut `received\|processed\|ignored\|failed`, résumé, dates |
| `integration_webhook_endpoints` | Propriétaire, projet, URL, description, secret **chiffré** et ancien secret pendant 24 h, événements (JSON), `active`, `consecutive_failures`, `disabled_reason`, derniers succès et échec |
| `integration_webhook_deliveries` | Webhook, `event_id`, type, contenu JSON, statut `pending\|delivering\|succeeded\|failed\|dead`, tentatives, `next_attempt_at`, code de réponse, dernière erreur, durée, `redelivery_of` |

## Jobs

| Job | Fréquence | Rôle |
| --- | --- | --- |
| `integrations.deliver` | 15 s, et après chaque mise en file | Envoie les livraisons dues (par lots), applique les nouvelles tentatives, l’abandon et la désactivation automatique |
| `integrations.purge` | Quotidien | Supprime les `state` OAuth expirés, les livraisons réussies de plus de 30 jours, les livraisons échouées ou abandonnées et les événements entrants de plus de 90 jours. Fait expirer (`dead`) les livraisons toujours en attente après 3 jours, ce qui n’arrive que sur un webhook désactivé |

## Limites et protections

| Élément | Limite |
| --- | --- |
| Sources par projet | 20 |
| Création de sources | 30 par heure et par membre |
| Webhooks sortants par projet | 10 par défaut (1 à 50, réglable) |
| Création de webhooks sortants | 20 par heure et par membre |
| Test et renvoi | 10 par minute et par webhook |
| Liste des dépôts et projets | 60 par minute et par membre |
| Démarrage OAuth | 20 par 10 minutes et par membre |
| Réception entrante | 600 par minute et par IP ; 300 par minute et par source |
| Échecs d’authentification entrants | Au-delà de 30 en 10 minutes pour une même IP et une même source : 429 |
| Notifications de push ou de commentaire | 1 toutes les 30 minutes par source |
| Annonces de version | 1 par version et par 24 h ; 3 par heure et par source |
| Taille des corps entrants | 2 Mo |
| Délai d’envoi sortant | 10 s, sans redirection |

## Sécurité et données personnelles

- **Secrets.** Jetons OAuth, secrets clients, secrets de webhook (entrants et sortants) et vérificateurs PKCE sont chiffrés avec `seal()` dans un contexte propre à chaque ligne.
  - Ils ne sont **jamais renvoyés par l’API** après leur création, ni journalisés.
  - Seul le secret d’une nouvelle source manuelle ou d’un nouveau webhook est affiché, une seule fois.
- **OAuth.** Le `state` est aléatoire, haché, lié à l’utilisateur, valable 10 minutes et à usage unique. PKCE est utilisé pour GitHub et GitLab. Les redirections de fin sont relatives.
- **Autorisations.** Seules les personnes qui gèrent le projet peuvent lier des sources ou créer des webhooks ; les autres reçoivent 404. Un membre ne voit que ses propres connexions.
- **Webhooks entrants.** Les comparaisons se font à temps constant. Un 401 ne dit pas si la source existe. Les livraisons sont dédupliquées par identifiant de livraison. Les textes reçus sont nettoyés (caractères de contrôle) et tronqués avant affichage.
- **Webhooks sortants.** Contenu minimal, signature HMAC horodatée, protection SSRF complète, aucune redirection suivie. Dans l’administration, les URL sont affichées sans chaîne de requête.
- **RGPD** (`registerPersonalData('integrations')`) :
  - l’**export** inclut les comptes connectés (sans jetons), les webhooks sortants (sans secrets) et les sources créées par le membre ;
  - l’**effacement** supprime les connexions, les `state` en cours et les webhooks sortants du membre, puis tente la révocation chez les fournisseurs après validation de la transaction. Les sources du projet sont conservées, mais `created_by` passe à `NULL`.
- **Audit.** Création et suppression de sources, rotation des secrets, création, modification et suppression de webhooks, connexions et déconnexions, ainsi que les actions d’administration.

## Limitations connues

- **Réception publique.** Les webhooks entrants ne fonctionnent que si `PUBLIC_API_ORIGIN` est **public et en HTTPS**. En développement (`127.0.0.1`), les fournisseurs refusent l’URL : la liaison bascule alors en mode manuel.
- **Création automatique des webhooks.** Elle suppose des droits élevés :
  - GitHub : `admin:repo_hook` et rôle d’administrateur du dépôt ;
  - GitLab : scope `api` et rôle *Maintainer* ;
  - Figma : `webhooks:write` et droits d’édition sur le fichier.

  Sinon, la configuration est manuelle.
- **Figma.** Pas de PKCE ni de révocation de jeton par API : le membre doit retirer l’application dans Figma. Les webhooks Figma doivent être créés par une personne ayant accès au fichier.
- **Scopes GitHub.** Les scopes des OAuth Apps sont larges (`repo` = accès complet aux dépôts privés) : ne proposez l’option « dépôts privés » que si c’est nécessaire.
- **Événements non émis.** `task.deleted` n’existe pas (la suppression d’une tâche n’est pas exposée), et les messages privés ne sont jamais publiés.
- **Activité des projets.** Il n’existe pas de fil d’activité de projet dans le schéma : les résumés des événements entrants vivent dans `integration_inbound_events` et s’affichent dans l’onglet Sources.
- **File d’envoi.** Elle repose sur SQLite et le planificateur intégré, avec un seul nœud actif à la fois (voir `docs/v4/ops.md`).
- **Ordre des événements.** Il n’est pas garanti, notamment en cas de nouvelle tentative : utilisez `created_at` et l’état actuel de la ressource.

## Points juridiques

- **Base légale.** Connecter un compte tiers est un choix du membre, fondé sur l’exécution du service. Alpha ne stocke que l’identifiant et le login externes ainsi que les jetons nécessaires ; il ne lit ni ne copie le code source.
- **Conditions des fournisseurs.** Les conditions et politiques API de GitHub, GitLab et Figma s’appliquent : quotas, interdiction d’usages abusifs, et obligation d’afficher clairement l’application à l’utilisateur. L’exploitant doit publier ses applications OAuth sous son identité et tenir à jour la politique de confidentialité, qui doit mentionner ces sous-traitants et transferts éventuels hors UE.
- **Responsabilité des webhooks sortants.** Le membre choisit où il envoie les données de son projet et en est responsable (destinataire, hébergement, sécurité). Les identifiants d’autres membres (`tester_id`) sont transmis sous forme de pseudonymes techniques, sans coordonnées.
- **Conservation.** Livraisons réussies : 30 jours. Livraisons échouées et événements entrants : 90 jours. Connexions : jusqu’à la déconnexion ou l’effacement du compte.
