# Prestataires de paiement (V4)

Alpha encaisse les paiements des missions, verse les gains des contributeurs et rembourse les clients par l’intermédiaire de **prestataires
de paiement agréés**. Alpha ne détient jamais les fonds : chaque prestataire porte la licence (établissement de paiement ou de monnaie
électronique) et réalise la vérification d’identité (KYC/KYB) de ses marchands.

Ce document décrit les huit adaptateurs livrés (le simulateur et sept prestataires réels), ce qu’il faut configurer dans la console
d’administration, les webhooks à déclarer, et les limites connues.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Contrat commun (lecture seule) | `server/payments/providers/types.ts` |
| Client HTTP partagé (délais, erreurs, masquage, signatures, numéros) | `server/payments/providers/http.ts` |
| Adaptateurs | `stripe.ts`, `flutterwave.ts`, `campay.ts`, `mtn-momo.ts`, `orange-money.ts`, `wave.ts`, `kratos-pay.ts` (dans `server/payments/providers/`) |
| Simulateur (bac à sable Alpha) | `server/payments/providers/simulator.ts` |
| Registre | `server/payments/providers/index.ts` |
| Tests (fetch simulé, aucun appel réseau) | `tests/payment-providers-v4.test.ts` |

## Principes communs

- **Clients HTTP purs.** Les adaptateurs n’accèdent jamais à la base de données. Ils reçoivent une configuration (`settings` non secrets,
  `secrets` déchiffrés par le module paiements) et un contexte (`fetch` avec délai de 20 s, horloge, URL de webhook, URL de retour).
- **Montants.** Alpha manipule des montants en unités mineures selon l’exposant ISO 4217 de `server/payments/mode.ts` (EUR = 2 décimales,
  XAF/XOF/GNF/UGX/RWF = 0). Chaque adaptateur convertit vers l’unité attendue par le prestataire :

  | Prestataire | Unité envoyée | Exemple 12,50 € | Exemple 5 000 FCFA |
  | --- | --- | --- | --- |
  | Stripe | unités mineures Stripe (devises « zero-decimal » en unités entières) | `1250` | `5000` |
  | Flutterwave | unités **majeures**, nombre décimal | `12.5` | `5000` |
  | CamPay | chaîne d’entiers XAF | — | `"5000"` |
  | MTN MoMo | chaîne en unités majeures | `"12.50"` (bac à sable) | `"5000"` |
  | Orange Money | entier en unités majeures | — | `5000` |
  | Wave | chaîne en unités majeures | — | `"5000"` |
  | Kratos Pay | entier XAF | — | `5000` |

  Un montant non représentable (par exemple des centimes en XAF) est refusé avant tout appel.
- **Statuts.** Les statuts des prestataires sont ramenés à `pending`, `succeeded`, `failed` ou `cancelled`. `status()` renvoie aussi
  `amountMinor` et `currency` quand le prestataire les fournit, afin que le module paiements contrôle le montant avant de créditer.
- **Idempotence.** La référence Alpha (`pay_…`, ≤ 64 caractères) sert de référence marchand. Quand le prestataire accepte une clé
  d’idempotence, elle vaut `alpha-collect-<réf>`, `alpha-payout-<réf>`, `alpha-refund-<réf>` (Stripe, Wave) ou `alpha-payin-<réf>` (Kratos).
  MTN reçoit un `X-Reference-Id` UUID dérivé de façon déterministe de la référence (une relance renvoie le même UUID, le 409 est accepté).
- **Erreurs.** `ProviderError.retryable` vaut `true` pour les erreurs réseau, les délais dépassés, les 408, les 429 et les 5xx. Il vaut
  `false` pour les autres 4xx, les 401/403 (configuration à corriger) et les refus métier. Les messages sont en français et sont
  **nettoyés** : secrets de la configuration, jetons obtenus à l’exécution, en-têtes `Bearer/Basic/Token`, adresses e-mail et numéros
  (téléphone, compte) sont masqués. Ils sont tronqués à 200 caractères.
- **Jetons OAuth.** CamPay, MTN et Orange utilisent un jeton d’accès mis en cache **en mémoire** par processus (clé dérivée des identifiants,
  expiration anticipée de 60 s). Il est renouvelé une fois automatiquement sur 401.
- **Webhooks = indices.** Un webhook authentifié peut porter un statut final (Stripe, Flutterwave, CamPay, Wave, Kratos). Quand le
  prestataire ne signe pas ses notifications (MTN, Orange), l’adaptateur ne renvoie qu’un événement `pending` avec la référence, et le module
  paiements **reconfirme toujours par `status()`**. `verifyWebhook` renvoie `null` si l’authenticité n’est pas prouvée (réponse 401) et `[]`
  s’il n’y a rien à traiter.
- **Numéros de téléphone.** Ils sont normalisés au format international sans `+` (`2376…`, `2250…`) selon le pays du prestataire. Le
  0 initial est conservé pour la Côte d’Ivoire et le Bénin (plans de numérotation à 10 chiffres). Ils n’apparaissent jamais dans les
  instructions affichées ni dans les messages d’erreur.

## URL de webhook à déclarer

Pour chaque prestataire, déclarez dans son tableau de bord :

```
<PUBLIC_API_ORIGIN>/api/payments/webhooks/<id>
```

`<id>` vaut `stripe`, `flutterwave`, `campay`, `mtn_momo`, `orange_money`, `wave` ou `kratos_pay`. L’URL doit être en **HTTPS** en
production. Pour MTN (`kind`, `ref`, `sig`) et Orange (`ref`, `sig`), Alpha ajoute à cette URL, transaction par transaction, des
paramètres liant la notification à la référence (`sig` = HMAC de la référence). Il n’y a rien à déclarer côté tableau de bord, car l’URL est
envoyée avec chaque demande de paiement.

## Matrice des capacités

| Id | Prestataire | Pays | Devises | Moyens | Encaissement | Versement | Remboursement | Webhooks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `simulator` | Simulateur Alpha | tous | EUR, XAF, XOF, USD | carte, mobile money | oui | oui | oui | signés |
| `stripe` | Stripe | tous (Connect selon pays) | EUR, USD, GBP, CHF, CAD, XAF, XOF | carte | Checkout | Transfers vers comptes Connect `acct_…` | oui (partiel) | signés (`Stripe-Signature`) |
| `flutterwave` | Flutterwave v3 | CM, CI, SN, BF, ML, BJ, TG, NE, GA, CG, NG, GH, KE, UG, RW, TZ, ZA | XAF, XOF, NGN, GHS, KES, UGX, RWF, TZS, ZAR, EUR, USD, GBP | carte, mobile money, virement | lien hébergé | `/v3/transfers` (mobile money, banque) | oui (partiel) | `verif-hash` |
| `campay` | CamPay | CM | XAF | mobile money (MTN, Orange) | USSD ou lien de paiement | `/withdraw/` | non | JWT HS256 |
| `mtn_momo` | MTN MoMo Open API | CM, CI, BJ, CG, GN, UG, GH | EUR (bac à sable), XAF, XOF, GNF, UGX, GHS | mobile money | Request to Pay | Disbursement Transfer | oui (Disbursement Refund) | **non signés** |
| `orange_money` | Orange Money Web Payment | CI, SN, ML, BF, CM, GN | XOF, XAF, GNF (OUV en bac à sable) | mobile money | page Orange hébergée | non | non | **non signés** |
| `wave` | Wave Checkout | SN, CI, ML, BF | XOF | mobile money | session Checkout | `/v1/payout` | oui (intégral seulement) | signés (`Wave-Signature`) |
| `kratos_pay` | Kratos Pay | CM | XAF | mobile money (MTN, Orange) | payin USSD | payout | non | HMAC-SHA256 |

## Réglementation et responsabilités

- **Union européenne** : les prestataires (Stripe, Flutterwave pour l’Europe) sont agréés DSP2/DME2. L’authentification forte (3-D Secure)
  est gérée par la page hébergée Stripe Checkout ou Flutterwave.
- **CEMAC (Cameroun, Congo, Gabon…)** : la monnaie électronique relève de la COBAC/BEAC. CamPay, Kratos Pay, MTN et Orange portent
  l’agrément ou opèrent sous celui d’un émetteur. Alpha doit signer un contrat marchand et fournir ses documents KYB.
- **UEMOA (Côte d’Ivoire, Sénégal, Mali, Burkina Faso, Bénin…)** : la monnaie électronique relève de la BCEAO. Wave, Orange et MTN sont
  émetteurs agréés.
- Les versements aux contributeurs (payouts) peuvent exiger des **vérifications supplémentaires** chez le prestataire : KYC du
  bénéficiaire (Stripe Connect), liste blanche d’IP ou validation manuelle (Flutterwave, CamPay), activation spécifique du produit
  Disbursement (MTN) ou de la permission Payout (Wave).
- Alpha ne stocke ni numéro de carte ni code PIN : les cartes sont saisies sur les pages hébergées, et les validations mobile money se font
  sur le téléphone du client.

## Stripe

- **Compte** : compte Stripe activé (KYB de la société), et **Stripe Connect** (plateforme) pour les versements aux contributeurs. Chaque
  contributeur doit avoir un compte connecté `acct_…` vérifié, créé par le module comptes et versements. Le modèle utilisé est « charges et
  transferts séparés ».
- **Bac à sable** : mode test du tableau de bord, clés `sk_test_…` (ou restreintes `rk_test_…`). Carte de test `4242 4242 4242 4242`.
  Pour recevoir les webhooks en local, utilisez `stripe listen --forward-to <PUBLIC_API_ORIGIN>/api/payments/webhooks/stripe`.
- **Champs** : `secret_key` (secret, `sk_test_`/`rk_test_` en bac à sable, `sk_live_`/`rk_live_` en production, vérifié), `webhook_secret`
  (secret, `whsec_…`), `currency`, `api_version` (facultatif, en-tête `Stripe-Version`), `base_url` (tests uniquement).
- **Webhook** : créez un endpoint pointant vers `…/api/payments/webhooks/stripe` avec les événements `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`,
  `refund.updated`, `refund.failed`, `charge.refund.updated`, `transfer.created`, `transfer.updated` et `transfer.reversed`. L’en-tête
  `Stripe-Signature` (`t=…,v1=…`, HMAC-SHA256 de `${t}.${corps}`) est vérifié avec une tolérance de 5 minutes. Plusieurs `v1` sont acceptés
  pendant une rotation de secret.
- **Opérations** :
  - Encaissement par Checkout Session (`mode=payment`, carte). L’API est appelée en formulaire encodé, avec un `Idempotency-Key`.
  - Statut via la session `cs_…` ou le PaymentIntent `pi_…`.
  - Remboursement total ou partiel (`/v1/refunds`).
  - Versement par `/v1/transfers` vers `acct_…`.
- **Devises** : XAF et XOF sont des devises « zero-decimal » chez Stripe. La liste complète de Stripe est appliquée, et UGX n’est pas
  proposé.
- **Précautions** :
  - Stripe Connect n’ouvre pas de comptes connectés dans tous les pays d’Afrique centrale et de l’Ouest (vérifier la liste des pays pris en
    charge).
  - Les transferts transfrontaliers sont limités : les contributeurs camerounais ou ivoiriens seront souvent payés via un prestataire
    mobile money.

## Flutterwave (API v3)

- **Compte** : compte marchand Flutterwave vérifié (KYB). L’activation des paiements par pays (Cameroun, Côte d’Ivoire, Sénégal…) et des
  virements (transfers) peut nécessiter une demande au support, ainsi qu’une **liste blanche d’IP** pour les transfers.
- **Bac à sable** : basculez le tableau de bord en mode test. Clés `FLWSECK_TEST-…`. La même URL `https://api.flutterwave.com` sert aux
  deux environnements, et la clé détermine le mode. Les cartes et numéros de test sont listés dans la documentation Flutterwave.
- **Champs** : `secret_key` (secret, `FLWSECK_TEST-`/`FLWSECK-` contrôlé selon l’environnement), `secret_hash` (secret, ≥ 16 caractères,
  saisi aussi dans Settings → Webhooks), `currency`, `payment_options` (facultatif, ex. `card,mobilemoneyfranco`), `base_url`.
- **Webhook** : URL `…/api/payments/webhooks/flutterwave`. Flutterwave envoie l’en-tête `verif-hash`, comparé en temps constant au secret
  hash. La variante `flutterwave-signature` (HMAC-SHA256 base64 du corps) est également acceptée.
- **Opérations** :
  - Lien de paiement hébergé `/v3/payments`. Le montant est en unités **majeures** décimales. `tx_ref` = référence Alpha.
  - Statut via `/v3/transactions/verify_by_reference?tx_ref=…`. Une transaction encore inconnue est traitée comme `pending`.
  - Versements `/v3/transfers` vers un compte mobile money ou bancaire, statut `/v3/transfers/:id`. Le code `account_bank` est déduit du
    pays et de l’opérateur, ou forcé via `recipient.bankCode`.
  - Remboursements `/v3/transactions/:id/refund`, statut `/v3/refunds/:id`.
- **Précautions** : le code `account_bank` mobile money pour le Cameroun (`FMM`) n’est pas documenté de façon univoque. Fournissez
  `bankCode` si Flutterwave vous en communique un autre.

## CamPay (Cameroun)

- **Compte** : compte CamPay vérifié (pièces de la société). Créez une **application** dans le tableau de bord pour obtenir les identifiants
  d’accès API (App username et App password) et la **clé webhook**. Les retraits (payouts) doivent être activés par CamPay.
- **Bac à sable** : `https://demo.campay.net/api`. Créez une application de démonstration sur demo.campay.net. Les montants y sont
  plafonnés à de petites sommes, et les validations se font avec de vrais numéros MTN/Orange. Production : `https://www.campay.net/api`.
- **Champs** : `app_username`, `app_password`, `webhook_key` (secrets), `currency` (XAF), `collect_mode` (`ussd` : demande envoyée au
  téléphone du client, numéro requis ; `payment_link` : page hébergée CamPay), `base_url`.
- **Webhook** : déclarez `…/api/payments/webhooks/campay` comme URL de callback de l’application. CamPay appelle l’URL (GET avec paramètres
  ou POST) avec un paramètre `signature` : un **JWT HS256 signé avec la clé webhook**. Il est vérifié (algorithme, signature, expiration
  avec 5 min de marge). Les champs présents dans le JWT (référence, statut, montant) doivent correspondre aux paramètres reçus. Sans JWT
  valide, la notification est rejetée.
- **Opérations** :
  - Jeton via `/token/`, puis en-tête `Authorization: Token …`.
  - Encaissement `/collect/` (montant entier XAF, numéro `237…`), statut initial `pending_approval`. Sans numéro, un lien est obtenu via
    `/get_payment_link/`.
  - Statut via `/transaction/{reference}/`.
  - Versement `/withdraw/`.
  - **Pas de remboursement** par API : il faut faire un versement manuel.

## MTN Mobile Money (MoMo Open API)

- **Compte** :
  - Bac à sable : inscription sur momodeveloper.mtn.com et souscription aux produits **Collection** (et **Disbursement** pour les
    versements et remboursements).
  - Production : contrat marchand avec l’opérateur MTN du pays (KYB, compte marchand MoMo), puis fourniture par MTN des identifiants de
    production.
- **Bac à sable** :
  - Base `https://sandbox.momodeveloper.mtn.com`, environnement cible `sandbox`, devise **EUR**.
  - Créez l’API User (UUID) et l’API Key avec l’API de provisionnement (`POST /v1_0/apiuser`, puis `/v1_0/apiuser/{uuid}/apikey`) en
    déclarant comme `providerCallbackHost` l’hôte de `PUBLIC_API_ORIGIN`.
  - Les numéros de test qui simulent chaque statut sont listés par MTN.
- **Production** :
  - MTN migre vers la plateforme « One API » : la base par défaut est `https://momoapi.momo.africa` (l’ancienne
    `proxy.momoapi.mtn.com` peut être saisie dans `base_url` si votre contrat l’impose).
  - Les identifiants de production (User ID + Credential Token) ne sont pas forcément des UUID.
  - L’environnement cible est celui de votre marché : `mtncameroon` (XAF), `mtnivorycoast` (XOF), `mtnbenin` (XOF), `mtncongo` (XAF),
    `mtnguineaconakry` (GNF), `mtnuganda` (UGX) ou `mtnghana` (GHS).
- **Champs** :
  - `target_environment`, `currency` (doit correspondre à l’environnement).
  - Collection : `collection_subscription_key`, `collection_api_user`, `collection_api_key` (secrets).
  - Disbursement, facultatif, les trois ou aucun : `disbursement_subscription_key`, `disbursement_api_user`, `disbursement_api_key`.
  - `base_url`.
- **Webhook** : rien à déclarer. L’URL `…/api/payments/webhooks/mtn_momo?kind=…&ref=…&sig=…` est transmise dans `X-Callback-Url` à chaque
  demande, uniquement si `PUBLIC_API_ORIGIN` est en HTTPS. MTN **ne signe pas** ses callbacks et ne les rejoue pas. Le paramètre `sig`
  (HMAC de la référence avec l’API Key) écarte les appels forgés. L’événement renvoyé est toujours `pending`, et le statut réel est relu par
  `status()`.
- **Opérations** :
  - Jeton `/{collection|disbursement}/token/` (Basic API User:API Key, `Ocp-Apim-Subscription-Key`, `X-Target-Environment`).
  - Encaissement `/collection/v1_0/requesttopay` avec `X-Reference-Id` UUID. Le client valide sur son téléphone.
  - Statut `GET …/requesttopay/{id}` : `SUCCESSFUL`, `FAILED`/`REJECTED`/`TIMEOUT`, et `APPROVAL_REJECTED`/`EXPIRED` → annulé.
  - Versement `/disbursement/v1_0/transfer`.
  - Remboursement `/disbursement/v1_0/refund`.

## Orange Money (Web Payment)

- **Compte** : application sur developer.orange.com abonnée à l’API « Orange Money Web Payment » du pays, puis contrat marchand Orange
  Money (KYB) qui fournit la **clé marchand** (`merchant_key`). Côte d’Ivoire, Sénégal, Mali, Burkina Faso (XOF), Cameroun (XAF) et
  Guinée (GNF) sont pris en charge.
- **Bac à sable** : en environnement « bac à sable », Alpha utilise automatiquement le chemin `/orange-money-webpay/dev/v1/…` et la devise de
  test **OUV**. Le pays configuré n’est utilisé qu’en production.
- **Champs** : `client_id`, `client_secret`, `merchant_key` (secrets), `country`, `currency` (doit correspondre au pays), `merchant_name`
  (≤ 30 caractères, affiché au client), `base_url`.
- **Webhook** : rien à déclarer. `notif_url` = `…/api/payments/webhooks/orange_money?ref=…&sig=…` est envoyé à chaque paiement. Orange
  inclut un `notif_token` dans la notification, mais Alpha ne peut pas le vérifier sans le stocker, et les adaptateurs n’ont pas de base de
  données. La notification est donc liée à la référence par `sig` (HMAC avec la clé marchand et le client secret) et traitée comme
  `pending`. Le statut est relu par `/transactionstatus`.
- **Opérations** :
  - Jeton OAuth `https://api.orange.com/oauth/v3/token` (client credentials).
  - Paiement `/webpayment` (montant entier) → `payment_url` hébergée. La référence prestataire encode
    `pay_token|order_id|montant|devise`, nécessaires à la consultation du statut.
  - Statut `/transactionstatus` : `SUCCESS`, `FAILED`, `EXPIRED` → annulé, `INITIATED`/`PENDING`.
  - **Ni versement ni remboursement** : l’API Web Payment ne les propose pas.

## Wave (Sénégal, Côte d’Ivoire)

- **Compte** : compte **Wave Business** (KYB). Dans le portail Développeurs, créez une clé API avec les permissions **Checkout** et, pour
  les versements, **Payout** (souvent soumise à validation par Wave).
- **Bac à sable** : **Wave n’offre pas de bac à sable**. Les clés sont toujours de production (`wave_sn_prod_…`, `wave_ci_prod_…`).
  L’adaptateur refuse une clé de production quand l’environnement Alpha est « bac à sable » : testez avec le simulateur Alpha, puis avec de
  petits montants réels.
- **Champs** :
  - `api_key` (secret, format `wave_<pays>_…`) et `webhook_secret` (secret, ≥ 16 caractères).
  - `webhook_auth` : `signing_secret`, recommandé, ou `shared_secret`.
  - `signing_secret` (facultatif, si la clé exige la signature des requêtes).
  - `country` (pays par défaut des bénéficiaires), `currency` (XOF), `aggregated_merchant_id` (`am-…`, facultatif), `base_url`.
- **Webhook** : créez un webhook vers `…/api/payments/webhooks/wave` avec les événements Checkout (`checkout.session.completed`,
  `checkout.session.payment_failed`) et Payout.
  - Avec `signing_secret`, l’en-tête `Wave-Signature: t=…,v1=…` est un HMAC-SHA256 de `t` + corps (**sans point**), avec une tolérance
    de 5 minutes.
  - Avec `shared_secret`, l’en-tête est `Authorization: Bearer <secret>`.
- **Opérations** :
  - Session Checkout `/v1/checkout/sessions` (montant en chaîne, XOF) → `wave_launch_url`.
  - Statut via la session (`payment_status`, `checkout_status`).
  - Versement `/v1/payout` avec `idempotency-key` (numéro E.164 `+221…`/`+225…`), statut `/v1/payout/:id` (`processing`, `succeeded`,
    `failed`/`reversed`).
  - Remboursement `/v1/checkout/sessions/:id/refund` : **intégral uniquement**, et synchrone.

## Kratos Pay (Cameroun)

- **Compte** : compte marchand Kratos Pay (agrégateur MTN MoMo et Orange Money Cameroun, KYB). Le tableau de bord fournit une clé publique
  Sandbox et une clé publique Live, ainsi que le secret de signature des webhooks.
- **Bac à sable** : base `https://dev-aggregator-api.kratospay.com` avec la clé Sandbox. Par défaut, Alpha utilise le préfixe
  `/api/v1/sandbox` en bac à sable et `/api/v1/live` en production (voir « Ambiguïtés »). Ajustez `api_path` si Kratos vous indique un
  autre chemin.
- **Champs** :
  - `public_key` : saisie comme secret, envoyée dans `X-MoK-Public-Key` et jamais exposée au navigateur.
  - `webhook_secret` (≥ 16 caractères) et `currency` (XAF).
  - `webhook_signature_header` (par défaut `X-MoK-Signature`).
  - `api_path`.
  - `status_path` (par défaut `<api_path>/transactions/{reference}`, variables `{reference}` et `{kind}`).
  - `base_url`.
- **Webhook** : déclarez `…/api/payments/webhooks/kratos_pay`. La signature HMAC-SHA256 du corps brut est acceptée en hexadécimal, en
  base64, avec ou sans préfixe `sha256=`, ou au format `t=…,v1=…` (sur `${t}.${corps}`, tolérance de 5 minutes).
- **Opérations** :
  - Payin `POST <api_path>/payin` avec `{amount, currency: 'XAF', phoneNumber: '237…', operator, reference, description}` et un en-tête
    `Idempotency-Key`. L’opérateur (`mtn_momo_cm` ou `orange_money_cm`) est déduit du numéro ou choisi par le client.
  - Statuts `PENDING`, `SUCCESS` et `FAILED`.
  - Payout `POST <api_path>/payout`.
  - Pas de remboursement documenté.

## Ambiguïtés de documentation et choix retenus

| Prestataire | Point | Choix |
| --- | --- | --- |
| Kratos Pay | Endpoint de consultation, préfixe bac à sable, nom de l’en-tête de signature et d’idempotence, forme exacte du webhook non publiés | Valeurs par défaut prudentes et toutes configurables (`api_path`, `status_path`, `webhook_signature_header`). Le préfixe bac à sable n’est jamais le chemin live. |
| Kratos Pay | La documentation n’impose que `X-MoK-Public-Key` | Aucun autre secret n’est envoyé. La clé est traitée comme un secret côté Alpha. |
| Flutterwave | Code `account_bank` mobile money au Cameroun | `FMM` par défaut, surchargeable par `recipient.bankCode`. |
| Flutterwave | En-tête `flutterwave-signature` (nouvelle génération) | Accepté en plus de `verif-hash` s’il correspond au HMAC du corps. |
| CamPay | Contenu exact des revendications du JWT `signature` | Signature, algorithme et expiration obligatoires. Les champs présents doivent correspondre aux paramètres. |
| MTN MoMo | Migration « One API » (nouvelle base, identifiants non UUID, `X-Target-Environment` sur l’appel de jeton) | Nouvelle base par défaut en production, contrôle UUID limité au bac à sable, `base_url` modifiable. |
| MTN MoMo | Callbacks non signés et non rejoués | Lien HMAC dans l’URL, statut toujours relu par `status()`. Le module doit aussi interroger périodiquement les paiements en attente. |
| Orange Money | `notif_token` non vérifiable sans stockage, longueur maximale d’`order_id` non précisée | Notification liée à la référence par HMAC d’URL et reconfirmée. Référence Alpha ≤ 64 caractères. |
| Wave | Pas de bac à sable, noms exacts des événements Payout | Clé de production refusée en bac à sable. Tout événement `payout.*` (ou objet `pt-…`) est traité comme un versement. |

## Limites connues

- Les caches de jetons (CamPay, MTN, Orange) sont **par processus** : avec plusieurs instances, chaque instance obtient son propre jeton.
- Les remboursements ne sont pas disponibles via API pour CamPay, Orange Money et Kratos Pay. Ceux de Wave sont intégraux uniquement.
- Orange Money ne propose pas de versement par l’API Web Payment.
- MTN et Orange ne signent pas leurs notifications : la confirmation dépend de `status()` et d’un rattrapage périodique.
- Les tests automatisés utilisent un `fetch` simulé conforme aux documentations publiques. Un essai réel dans chaque bac à sable (et, pour
  Wave, avec de petits montants réels) reste nécessaire avant l’ouverture en production.
