# Comptes et sécurité (V4)

Ce module durcit la gestion des comptes Alpha :

- vérification de l’adresse e-mail ;
- récupération du mot de passe ;
- double authentification TOTP avec codes de récupération ;
- connexion GitHub et Google (OAuth 2.0, code d’autorisation + PKCE) ;
- intégration aux garde-fous anti-abus et au consentement légal ;
- console d’administration.

L’inscription reste immédiate : la vérification de l’e-mail n’est **pas** obligatoire pour utiliser Alpha. Elle conditionne seulement l’association automatique avec un compte externe.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/005-accounts.sql` |
| Routes `/api/auth` (session, inscription, connexion, sessions, mot de passe) | `server/auth.ts` |
| Sessions et cookie | `server/accounts/session.ts` |
| Hachage scrypt et règles de mot de passe | `server/accounts/passwords.ts` |
| TOTP (RFC 6238) et base32 | `server/accounts/totp.ts` |
| Vérification e-mail et mot de passe oublié | `server/accounts/recovery.ts`, `server/accounts/emails.ts` |
| Double authentification | `server/accounts/mfa.ts` |
| OAuth (fournisseurs, configuration, PKCE) | `server/accounts/oauth.ts`, `server/accounts/oauthRoutes.ts` |
| État de sécurité du compte et politique | `server/accounts/status.ts` |
| Consentement légal | `server/accounts/legal.ts` |
| Administration | `server/accounts/admin.ts` |
| RGPD et purge | `server/accounts/privacy.ts` |
| Client | `src/lib/auth.tsx`, `src/pages/AuthPage.tsx`, `src/pages/AccountRecoveryPage.tsx`, `src/components/AccountSecurity.tsx`, `src/components/MfaSettings.tsx`, `src/components/OAuthButtons.tsx`, `src/components/LegalConsentBanner.tsx`, `src/admin/AuthAdmin.tsx`, `src/styles/accounts.css` |
| Tests | `tests/accounts-v4.test.ts` |

## Configuration

### Variables d’environnement

| Variable | Usage |
| --- | --- |
| `APP_ORIGIN` | Origine publique (ex. `https://alpha.example.fr`). Elle sert aux liens des e-mails, aux URL de rappel OAuth et aux redirections. |
| `ALPHA_SECRETS_KEY` | Clé maîtresse de `secrets.seal`. Elle chiffre les secrets TOTP, les vérificateurs PKCE et les secrets clients OAuth. **Sa perte rend les secrets TOTP illisibles.** |

### Réglages et secrets (console d’administration, section « Connexion et comptes »)

| Clé | Type | Contenu |
| --- | --- | --- |
| `auth.oauth.github` | réglage | `{ "enabled": boolean, "client_id": string }` |
| `auth.oauth.google` | réglage | `{ "enabled": boolean, "client_id": string }` |
| `auth.oauth.github.client_secret` | secret scellé | Secret client GitHub. Il n’est jamais renvoyé par l’API : seul un masque est affiché. |
| `auth.oauth.google.client_secret` | secret scellé | Secret client Google. Même traitement que pour GitHub. |
| `auth.policy` | réglage | `{ "require_admin_mfa": boolean }` (par défaut `false`) |

Un fournisseur n’apparaît sur la page de connexion qu’aux trois conditions suivantes :

- il est activé ;
- son `client_id` est renseigné ;
- son secret client est enregistré.

L’URL de rappel à déclarer chez le fournisseur est `${APP_ORIGIN}/api/auth/oauth/<github|google>/callback`. La console l’affiche avec un bouton « Copier ».

| Fournisseur | Portées demandées | Données lues |
| --- | --- | --- |
| GitHub | `read:user user:email` | `GET /user`, puis `GET /user/emails`. Seule l’adresse **principale et vérifiée** est retenue. |
| Google | `openid email profile` | Point de jeton, puis `userinfo` OpenID. `email_verified` doit valoir `true`. |

Alpha n’obtient aucun accès aux dépôts ni aux fichiers des utilisateurs.

## Modèle de données (migration 005)

- `users.email_verified_at` : colonne ajoutée. Tous les comptes existants sont rétro-remplis comme vérifiés, avec leur date de création.
- `email_verification_tokens` et `password_reset_tokens` :
  - seul le haché SHA-256 du jeton est stocké ;
  - chaque jeton a un `expires_at` et un `used_at`, et ne sert qu’une fois.
- `mfa_totp` :
  - le secret est scellé avec le contexte `mfa:<userId>` ;
  - les colonnes `enabled_at` et `last_used_step` (anti-rejeu) complètent la table.
- `mfa_recovery_codes` : codes à usage unique, hachés avec l’identifiant de l’utilisateur.
- `mfa_challenges` :
  - défi de connexion en deux étapes, dont l’identifiant est stocké haché ;
  - il expire après 5 minutes et compte les essais (5 au maximum).
- `oauth_identities` :
  - `(provider, provider_user_id)` est unique ;
  - un utilisateur a au plus une identité par fournisseur.
- `oauth_states` :
  - état haché, fournisseur et mode `login` ou `link` ;
  - `user_id` en mode `link`, vérificateur PKCE scellé et chemin de retour ;
  - expiration après 10 minutes.

Le job `accounts.purge` tourne toutes les heures. Il supprime :

- les jetons expirés, et les jetons utilisés depuis plus de 24 h ;
- les défis MFA expirés ou consommés ;
- les états OAuth expirés.

## Parcours

### Vérification de l’adresse e-mail

1. À l’inscription, un e-mail sensible est mis en file (`renderEmail` + `queueEmail`). Il contient le lien `/verify-email?token=…`, valable **48 heures**.
2. La page `/verify-email` envoie automatiquement `POST /api/auth/verify-email { token }`. Le jeton est consommé, puis retiré de l’URL.
3. `POST /api/auth/verify-email/resend` (connecté) envoie un nouveau lien et invalide les précédents. La limite est de 3 envois par heure.

Associer un compte GitHub ou Google dont l’adresse vérifiée est identique vaut vérification.

### Mot de passe oublié

1. `POST /api/auth/password/forgot { email }` répond **toujours 202** avec le même message, que le compte existe ou non. Le temps de réponse est égalisé pour éviter l’énumération des comptes.
   - Limites : 10 requêtes / 15 min par IP, et 5 envois par heure par adresse (clé hachée).
2. L’e-mail contient `/reset-password?token=…`, valable **1 heure**. Une nouvelle demande invalide les liens précédents.
3. `POST /api/auth/password/reset { token, password }` applique les mêmes règles qu’à l’inscription (10 à 128 caractères). Il :
   - enregistre un nouveau haché scrypt ;
   - consomme le jeton ;
   - ferme **toutes** les sessions ;
   - envoie un e-mail « mot de passe modifié » ;
   - appelle `recordSignal('password_reset')`.

Un compte créé via GitHub ou Google n’a pas de mot de passe. Il en définit un par ce même parcours, via le bouton « Définir un mot de passe » dans les paramètres.

### Double authentification (TOTP)

Paramètres : RFC 6238, HMAC-SHA1, 6 chiffres, pas de 30 s, tolérance de ±1 pas. L’implémentation utilise `node:crypto` et un codage base32 maison. Le QR code est généré par `qrcode` à partir de l’URI `otpauth://totp/Alpha:<email>?issuer=Alpha…`.

1. `POST /api/auth/mfa/setup { password }` exige le mot de passe actuel, sauf pour un compte sans mot de passe (OAuth uniquement). Il renvoie :
   - le secret ;
   - l’URI `otpauth` ;
   - le QR code (data URL).
2. `POST /api/auth/mfa/enable { code }` active la double authentification. Il renvoie **une seule fois** 10 codes de récupération au format `xxxx-xxxx-xxxx-xxxx`, téléchargeables en `.txt`.
3. `POST /api/auth/mfa/recovery-codes { code }` régénère les codes ; les anciens deviennent invalides.
4. `POST /api/auth/mfa/disable { password, code }` accepte un code TOTP ou un code de récupération.

Connexion avec double authentification :

- `POST /api/auth/login` réussi renvoie `{ mfa_required: true, challenge }` **sans créer de session**.
- `POST /api/auth/mfa/verify { challenge, code | recovery_code }` crée la session.
- Le défi dure 5 minutes et accepte 5 essais ; ensuite il est bloqué (410) et il faut se reconnecter.
- Utiliser un code de récupération envoie un e-mail de sécurité indiquant le nombre de codes restants.
- Un code TOTP déjà utilisé est refusé (anti-rejeu par `last_used_step`, mis à jour par compare-and-set).
- Chaque échec appelle `recordSignal('mfa_failed')`.
- La connexion OAuth d’un compte protégé redirige vers `/login?mfa=<challenge>&next=<chemin>`.

### Connexion GitHub / Google

- `GET /api/auth/oauth/:provider/start?mode=login|link&redirect=/chemin` :
  - crée un état aléatoire (cookie `alpha_oauth_state` HttpOnly, restreint à `/api/auth/oauth`) et un vérificateur PKCE S256 ;
  - redirige ensuite (302) vers le fournisseur ;
  - `redirect` doit être un chemin relatif du même site ; sinon `/` est utilisé (pas de redirection ouverte).
- `GET /api/auth/oauth/:provider/callback` :
  - vérifie l’état (cookie + base, usage unique, 10 min) ;
  - échange le code avec le vérificateur ;
  - lit le profil, puis applique les règles ci-dessous.

| Situation | Résultat |
| --- | --- |
| Identité déjà connue | Connexion, ou défi MFA si la double authentification est active |
| Connecté et `mode=link` | Association au compte courant (retour sur `redirect?oauth=linked&provider=…`) |
| Compte local avec la même adresse, vérifiée des deux côtés | Association automatique puis connexion |
| Compte local avec la même adresse non vérifiée | Refus `account_exists` : se connecter avec le mot de passe puis associer depuis les paramètres |
| Aucun compte | Création d’un compte : e-mail vérifié, sans mot de passe, CGU et politique de confidentialité acceptées (la page de connexion indique que continuer vaut acceptation) |

En cas d’échec, l’utilisateur est renvoyé vers `/login?oauth_error=<code>`, ou vers la page d’origine en mode `link`. Codes possibles :

| Code | Cause |
| --- | --- |
| `state` | État absent, expiré ou ne correspondant pas au cookie |
| `access_denied` | Autorisation refusée chez le fournisseur |
| `provider_error` | Échec d’échange ou de lecture du profil |
| `provider_disabled` | Fournisseur désactivé |
| `email_unverified` | Le fournisseur ne garantit pas l’adresse |
| `account_exists` | Une association automatique n’est pas possible |
| `identity_taken` | Ce compte externe est déjà lié à un autre utilisateur |
| `already_linked` | Le compte possède déjà une identité de ce fournisseur |
| `login_required` | Session absente ou changée en mode `link` |
| `restricted` | Compte restreint par la modération |

`DELETE /api/auth/oauth/identities/:provider` dissocie une identité. C’est autorisé seulement si l’utilisateur conserve un mot de passe ou une autre identité. Toute association ou dissociation déclenche un e-mail de sécurité et une entrée d’audit.

### Garde-fous

- `attachUser` traite comme déconnecté un utilisateur sous restriction `accountRestriction(id, 'login')`. Selon la politique du module trust, seule une exclusion (`ban`) non contestable bloque la connexion ; un membre suspendu peut toujours se connecter pour lire la motivation et faire appel.
- La connexion (mot de passe, OAuth ou MFA) est refusée avec le message de restriction.
- Signaux transmis au module trust :
  - `register` ;
  - `login`, `login_failed` ;
  - `oauth_login` ;
  - `password_reset` ;
  - `mfa_failed`.
- Les limites de débit utilisent `platform/rateLimit` (persistant, clés hachées) :
  - connexion, inscription et changement de mot de passe : 30 / 15 min par IP ;
  - connexion par compte : 20 / 15 min ;
  - vérification MFA : 30 / 15 min ;
  - gestion MFA et dissociation : 20 / 15 min par utilisateur ;
  - démarrage et retour OAuth : 30 / 15 min ;
  - réinitialisation : 20 / 15 min.
- Politique `auth.policy.require_admin_mfa` : tant qu’elle est active, un administrateur sans double authentification est traité comme simple membre. Il garde l’accès aux paramètres pour l’activer.

### Consentement légal

- `POST /api/auth/register` accepte `accept_terms: true`, et enregistre alors l’acceptation de `terms` et `privacy`. La case est obligatoire dans le formulaire, mais pas dans l’API, pour rester compatible.
- `GET /api/auth/legal` renvoie les documents à accepter.
- `POST /api/auth/legal/accept { documents: [...] }` les accepte.
- `LegalConsentBanner` (sans props) affiche les documents en attente (`user.pending_legal`) avec des liens vers `/legal/<document>`. « Plus tard » masque la bannière pour la session du navigateur.

## API

| Méthode et chemin | Accès | Rôle |
| --- | --- | --- |
| `GET /api/auth/me` | public | Utilisateur courant. S’y ajoutent `email_verified`, `mfa_enabled`, `has_password`, `pending_legal` et `admin_mfa_required`. |
| `GET /api/auth/account` | connecté | État de sécurité complet : e-mail, MFA, identités, fournisseurs, possibilité de dissocier, politique |
| `POST /api/auth/register` | public | Inscription (option `accept_terms`) et envoi de l’e-mail de vérification |
| `POST /api/auth/login` | public | Connexion, ou `{ mfa_required, challenge }` |
| `POST /api/auth/logout` | public | Déconnexion |
| `POST /api/auth/password` | connecté | Changement de mot de passe (ferme les autres sessions) |
| `GET /api/auth/sessions` | connecté | Liste des sessions actives |
| `DELETE /api/auth/sessions/:id` | connecté | Révoque une session |
| `POST /api/auth/sessions/revoke-others` | connecté | Ferme toutes les autres sessions |
| `POST /api/auth/verify-email` | public | Valide un lien de vérification |
| `POST /api/auth/verify-email/resend` | connecté | Renvoie le lien |
| `POST /api/auth/password/forgot` | public | Demande de réinitialisation (toujours 202) |
| `POST /api/auth/password/reset` | public | Nouveau mot de passe via le jeton |
| `GET /api/auth/mfa` | connecté | État MFA |
| `POST /api/auth/mfa/setup` | connecté | Démarre la configuration |
| `POST /api/auth/mfa/enable` | connecté | Active et renvoie les codes de récupération |
| `POST /api/auth/mfa/disable` | connecté | Désactive |
| `POST /api/auth/mfa/recovery-codes` | connecté | Régénère les codes |
| `POST /api/auth/mfa/verify` | public | Termine une connexion protégée |
| `GET /api/auth/oauth/providers` | public | Fournisseurs actifs pour les boutons |
| `GET /api/auth/oauth/:provider/start` | public | Démarre une connexion ou une association |
| `GET /api/auth/oauth/:provider/callback` | public | Retour du fournisseur |
| `DELETE /api/auth/oauth/identities/:provider` | connecté | Dissocie une identité |
| `GET /api/auth/legal` | connecté | Documents à accepter |
| `POST /api/auth/legal/accept` | connecté | Accepte des documents |
| `GET /api/auth/admin/oauth` | admin | Configuration OAuth : secrets masqués, URL de rappel |
| `PUT /api/auth/admin/oauth/:provider` | admin | `{ enabled, client_id, client_secret? }` : chaîne pour remplacer, `null` pour supprimer, absent pour conserver |
| `GET /api/auth/admin/policy` | admin | Politique et nombre d’administrateurs sans MFA |
| `PUT /api/auth/admin/policy` | admin | `{ require_admin_mfa }` |
| `GET /api/auth/admin/stats` | admin | E-mails vérifiés et MFA (nombres et pourcentages), administrateurs protégés, comptes sans mot de passe, identités par fournisseur, comptes avec moins de 3 codes de récupération |

Toutes les actions d’administration et de sécurité sont auditées :

- `auth.oauth_config_updated`, `auth.policy_updated` ;
- `auth.email_verified` ;
- `auth.password_reset`, `auth.password_changed` ;
- `auth.mfa_enabled`, `auth.mfa_disabled`, `auth.mfa_recovery_regenerated`, `auth.mfa_recovery_used` ;
- `auth.oauth_linked`, `auth.oauth_unlinked`, `auth.oauth_registered` ;
- `auth.legal_accepted` ;
- `auth.session_revoked`, `auth.sessions_revoked`.

## Données personnelles (RGPD)

`registerPersonalData('accounts', …)` :

- **Export** :
  - date de vérification de l’e-mail ;
  - présence d’un mot de passe ;
  - état MFA (activée le…, codes restants) ;
  - identités associées (fournisseur, e-mail, dates) ;
  - acceptations des documents légaux ;
  - nombre de liens de vérification ou de réinitialisation en attente.

  Aucun secret, haché ou jeton n’est exporté.
- **Effacement** : supprime les jetons de vérification et de réinitialisation, la configuration TOTP, les codes de récupération, les défis MFA, les identités et états OAuth. Les acceptations légales sont conservées comme preuve du consentement ; elles ne référencent que l’identifiant anonymisé.

## Sécurité et limites connues

- **Perte totale des facteurs MFA par un administrateur** (téléphone et codes de récupération) : aucun contournement n’existe dans l’interface. Un opérateur doit supprimer les lignes `mfa_totp` et `mfa_recovery_codes` de l’utilisateur directement en base, puis tracer l’intervention.
- Les restrictions de compte et les signaux dépendent du module trust (`server/platform/guards.ts`). Les signatures `accountRestriction(userId, 'login')` et `recordSignal(req, userId, kind, meta)` doivent rester stables.
- Aucun parcours de changement d’adresse e-mail n’existe encore. Une adresse modifiée ailleurs devra repasser par la vérification.
- Les textes des CGU et de la politique de confidentialité sont des modèles fournis par le module privacy ; ils doivent être validés juridiquement.
- Les appels réseau OAuth passent par un `fetch` injectable (`setOAuthFetchForTests`) ; les tests n’appellent jamais GitHub ni Google.
