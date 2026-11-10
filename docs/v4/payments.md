# Paiements : intentions, webhooks, séquestre et console d’administration (V4)

Ce module (« payments core ») fait circuler de l’argent **réel** (mode `live`) ou **de test** (mode `sandbox`) entre :
- les porteurs de projet, qui financent leurs campagnes de test ;
- les testeurs, payés à l’acceptation de leur mission ;
- les acheteurs et vendeurs de la marketplace.

Le mode `demo` reste **strictement identique à la V3** : paiements simulés, table `transactions`, aucun prestataire appelé. C’est le mode par défaut.

Les adaptateurs de prestataires (Stripe, Flutterwave, CamPay, MTN MoMo, Orange Money, Wave, Kratos Pay, simulateur) sont décrits dans
[payment-providers.md](payment-providers.md). Ce module ne les utilise **qu’à travers** l’interface `PaymentProvider`
(`collect`, `status`, `refund`, `verifyWebhook`) et le registre (`listProviders`, `getProvider`).

Le portefeuille, les retraits, le KYC et les factures relèvent du module conformité ([compliance.md](compliance.md)).

> **Avertissement.** Ce module fournit la mécanique technique (grand livre, séquestre, réconciliation). Il ne remplace ni un agrément de
> prestataire de services de paiement, ni la validation d’un avocat. Lisez la section « Cadre légal » avant d’activer le mode réel.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/007-payments.sql` |
| Routes membres (`/api/payments`) | `server/modules/payments.ts` |
| Intentions de paiement (création, rafraîchissement, annulation) | `server/payments/intents.ts` |
| Webhooks (`/api/payments/webhooks/:provider`) | `server/payments/webhooks.ts` |
| Séquestre et écritures (financement, versements, remboursements) | `server/payments/escrow.ts` |
| Simulateur de paiement (bac à sable) | `server/payments/checkout.ts` |
| API d’administration (`/api/payments/admin`) | `server/payments/admin.ts` |
| Accès aux données, frais, commandes, budget, remboursements, réconciliation, RGPD | `server/payments/core/*.ts` |
| Campagnes et missions | `server/modules/testing.ts` |
| Marketplace | `server/modules/marketplace.ts` |
| Interface | `src/components/CheckoutDialog.tsx`, `src/components/CheckoutStatus.tsx`, `src/pages/CheckoutPage.tsx`, `src/pages/PaymentsPage.tsx`, `src/pages/TestingPage.tsx`, `src/pages/MarketplacePage.tsx`, `src/admin/PaymentsAdmin.tsx`, `src/styles/payments.css` |
| Tests | `tests/payments-v4.test.ts` |

## Les trois modes

| Mode | Prestataires | Argent | Données |
| --- | --- | --- | --- |
| `demo` (défaut) | aucun | fictif | table `transactions` (V3) |
| `sandbox` | environnements de test des prestataires + simulateur intégré | fictif, mais parcours réel | `payment_intents` + grand livre `mode='sandbox'` |
| `live` | environnements de production des prestataires | **réel** | `payment_intents` + grand livre `mode='live'` |

- Le mode actif est le réglage `payments.mode`. Il se change depuis **Administration → Paiements** ; chaque changement est audité.
- Une campagne ou une commande est **verrouillée** sur le mode de son premier financement : colonne `payment_mode`, valant `demo` par défaut.
  - Une campagne financée en démonstration ne peut pas recevoir d’argent réel, et inversement.
  - Une campagne `sandbox` ne peut pas être complétée en `live`.
- Revenir de `live` à `sandbox` ou `demo` est toujours possible, mais :
  - les fonds déjà en séquestre restent gérés (versements, remboursements, réconciliation) ;
  - aucun nouveau paiement n’est accepté dans l’ancien mode ;
  - la console affiche un avertissement s’il reste des soldes.

## Schéma des flux

```
                         ┌───────────────────────────── Financement d’une campagne ─────────────────────────────┐
 Porteur ── POST /api/payments/intents {purpose:'campaign_funding', ref_id, provider, method?, phone?, operator?, currency?}
            │  1. transaction : contrôle (propriétaire, mode, budget restant) + INSERT payment_intents (status=created)
            │  2. hors transaction : provider.collect()  → redirect_url (carte) | instructions (mobile money) | échec (502)
            │  3. transaction : enregistrement provider_reference, status=pending
            ▼
 Prestataire ──► page de paiement / validation USSD sur le téléphone
            │
            ├──► POST|GET /api/payments/webhooks/:provider ──► verifyWebhook (signature)  ──► 401 si invalide
            │        dédoublonnage (payment_webhook_events.event_key UNIQUE)
            │        provider.status(reference)  ← re-confirmation systématique
            │        contrôle montant + devise   ← écart = « à examiner » + alerte admin, jamais de crédit
            │        règlement idempotent : journal campaign.funded  provider:<p> −X / escrow:campaign:<id> +X
            │
            └──► tâche payments.reconcile (toutes les 60 s) : même re-confirmation si aucun webhook n’arrive
 Navigateur ◄── /checkout/return?intent=… (interrogation jusqu’à l’état final)

 Mission acceptée (campagne sandbox/live) ──► journal mission.paid
        escrow:campaign:<id> −R / user:<testeur>:available +(R − frais) / platform:fees +frais

                         ┌───────────────────────────── Achat sur la marketplace ───────────────────────────────┐
 Acheteur ── POST /api/payments/intents {purpose:'order_purchase', ref_id:<listingId>, …}
            │  … mêmes étapes de collecte / webhook / réconciliation …
            ▼
 Paiement confirmé ──► création de la commande (status='paid', payment_mode verrouillé) + journal order.paid
        provider:<p> −X / escrow:order:<orderId> +X
 Livraison acceptée par l’acheteur ──► journal order.released
        escrow:order:<id> −X / user:<vendeur>:available +(X − frais) / platform:fees +frais
 Litige tranché en faveur de l’acheteur ──► refundOrderEscrow() ──► journal order.refunded + ligne refunds
        escrow:order:<id> −X / provider:<p> +X, puis provider.refund() après validation de la transaction (avec relances)

 Clôture d’une campagne sandbox/live ──► journal campaign.refunded (budget non réservé uniquement)
        escrow:campaign:<id> −X / provider:<p> +X, puis provider.refund() sur les paiements d’origine
```

## Modèle de séquestre (grand livre)

Tous les mouvements des modes `sandbox` et `live` passent par le grand livre en partie double (`server/payments/ledger.ts`). Ses écritures
sont immuables et équilibrées par mode et par devise : `ledgerIsBalanced()` doit toujours renvoyer `true`. Les montants sont en unités
mineures de la **devise de référence** (`payments.base_currency`, EUR par défaut).

| Type d’écriture | Référence | Lignes |
| --- | --- | --- |
| `campaign.funded` | `payment_intent/<intentId>` | `provider:<p>` −X, `escrow:campaign:<id>` +X |
| `mission.paid` | `mission/<missionId>` | `escrow:campaign:<id>` −R, `user:<testeur>:available` +(R−frais), `platform:fees` +frais |
| `campaign.refunded` | `campaign/<campaignId>` | `escrow:campaign:<id>` −X, `provider:<p>` +X |
| `order.paid` | `payment_intent/<intentId>` | `provider:<p>` −X, `escrow:order:<orderId>` +X |
| `order.released` | `order/<orderId>` | `escrow:order:<id>` −X, `user:<vendeur>:available` +(X−frais), `platform:fees` +frais |
| `order.refunded` | `order/<orderId>` | `escrow:order:<id>` −X, `provider:<p>` +X |
| `adjustment` | `admin/<id>` | lignes libres équilibrées, administrateur uniquement, motif obligatoire |

- **Idempotence.**
  - Chaque écriture porte la clé `<type>:<référence>`, par exemple `mission.paid:<missionId>`.
  - Un webhook rejoué, une réconciliation concurrente ou un double clic ne peuvent donc jamais créditer deux fois.
  - Les tests vérifient qu’un règlement concurrent ne produit qu’une seule écriture.
- **Disponibilité du budget.**
  - Les contrôles V3 sont conservés : on ne sélectionne pas de testeur sans budget disponible.
  - Pour une campagne réelle, ils sont calculés sur le solde du compte `escrow:campaign:<id>`, moins les récompenses réservées aux missions en cours.
- **Montant à financer.**
  - Campagne : récompense × places restantes, moins le séquestre existant.
  - Achat : prix de l’offre.
  - Le montant est converti de la devise de référence vers la devise du prestataire avec `fromBase`, arrondi au supérieur pour ne jamais sous-encaisser.
- **Notifications et audit.**
  - Chaque mouvement d’argent notifie le payeur et le bénéficiaire (`notify`) et est audité (`audit_events`).
  - Les incohérences alertent tous les administrateurs (notification `payments_alert`).

## Frais

Réglage `payments.fees` (dans `platform_settings`) : `{ "testing_fee_bps": 1000, "marketplace_fee_bps": 1000 }`.

- Les valeurs sont en points de base : 1000 = 10 %. Le maximum est 5000 (50 %).
- Les frais sont prélevés **au versement** : `mission.paid` pour les testeurs, `order.released` pour les vendeurs. Le payeur règle le montant affiché.
- Le compte `platform:fees` cumule les commissions. La facturation de ces commissions relève du module conformité.

## Intentions de paiement

Table `payment_intents`. Une intention a une durée de vie d’une heure. Principales colonnes :

| Groupe | Colonnes |
| --- | --- |
| Objet | `purpose`, `ref_type`/`ref_id`, `order_id` (rempli quand la commande est créée) |
| Prestataire | `mode`, `provider`, `method`, `operator`, `provider_reference` |
| Montants | `amount_base_minor`, `base_currency`, `amount_minor`, `currency`, `fx_rate` |
| État | `status` (`created`, `pending`, `succeeded`, `failed`, `cancelled`, `expired`), `settlement` (`none`, `settled`, `unapplied`), `review_required` |
| Parcours | `idempotency_key` (UNIQUE), `redirect_url`, `instructions`, `customer_phone_masked` (jamais le numéro complet), `expires_at`, `settled_journal_id` |
| Réconciliation | `attempts`, `next_check_at` |

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/api/payments/providers/available?purpose=&currency=` | Prestataires activés dans le mode courant : identifiant, libellé, méthodes, devises, opérateurs |
| POST | `/api/payments/intents` | Crée une intention et lance la collecte. Capacité `money` requise ; clé d’idempotence facultative |
| GET | `/api/payments/intents` | Mes paiements (pagination, filtres `purpose`, `ref_id`) |
| GET | `/api/payments/intents/:id` | Détail (payeur ou administrateur) |
| POST | `/api/payments/intents/:id/refresh` | Re-vérification immédiate via `status()` |
| POST | `/api/payments/intents/:id/cancel` | Abandon d’un paiement non abouti |
| POST | `/api/payments/simulator/:intentId/complete` | `{outcome:'succeeded'|'failed'}`, bac à sable uniquement, payeur uniquement |
| GET | `/api/payments/balances` | Soldes du grand livre du membre et séquestre de ses campagnes |
| POST | `/api/payments/campaigns/:id/refund` | Remboursement du budget non utilisé d’une campagne clôturée (propriétaire) |

**Règles d’autorisation de `POST /api/payments/intents` :**
- **Campagne.** Seul le propriétaire peut payer.
  - La campagne doit être ouverte et ne pas avoir de fonds de démonstration.
  - Son mode verrouillé doit être celui de la plateforme.
- **Achat.** L’offre doit être active, et le vendeur ne peut pas acheter sa propre offre.
- **Clé d’idempotence.**
  - Réutiliser une clé renvoie la même intention.
  - Une nouvelle tentative annule les intentions encore ouvertes du même membre pour le même objet.
- **Redirections.** Seuls un chemin relatif ou une URL HTTPS sont acceptés (HTTP seulement en bac à sable).

**Parcours utilisateur :**
- `CheckoutDialog` propose le prestataire, la méthode, la devise, puis l’opérateur et le téléphone pour le mobile money. Il apparaît uniquement quand `/api/health` indique un mode autre que `demo`.
- Le dialogue suit la `redirect_url`, ou affiche les instructions (validation USSD, par exemple).
- La page `/checkout/return?intent=…` interroge l’intention toutes les 2,5 s et la re-vérifie régulièrement, jusqu’à un état final clair : réussi, échoué ou à examiner.
- `/checkout/cancel?intent=…` annule le paiement.
- `/checkout/simulator?reference=…` propose les boutons « Payer » et « Échouer » du simulateur.

## Webhooks

URL à déclarer chez chaque prestataire : `https://<APP_ORIGIN>/api/payments/webhooks/<provider>`. Elle est affichée et copiable dans la console.

1. **Réception.**
   - Corps brut (`Buffer`) en POST, ou paramètres d’URL en GET pour les prestataires qui rappellent ainsi.
   - Seule la configuration de l’environnement **actif** est utilisée.
2. **Signature.** `provider.verifyWebhook()` est appelé. S’il renvoie `null`, la réponse est **401** et rien n’est enregistré.
3. **Dédoublonnage.**
   - Chaque événement est inséré dans `payment_webhook_events`, avec une `event_key` UNIQUE : l’identifiant d’événement du prestataire, ou le SHA-256 du corps.
   - Un doublon est acquitté sans retraitement.
4. **Re-confirmation.** L’intention est retrouvée par `reference` ou `provider_reference`, puis `provider.status()` est **toujours** rappelé. Le contenu du webhook ne suffit jamais à créditer.
5. **Contrôle du montant et de la devise.**
   - En cas d’écart : intention en échec et `review_required=1`.
   - Une alerte est envoyée aux administrateurs, et **aucun crédit** n’est fait.
6. **Règlement idempotent.**
   - L’écriture correspondante est passée.
   - Si la campagne a été clôturée ou l’offre retirée entre-temps, le paiement est marqué `settlement='unapplied'`.
   - Un remboursement automatique est alors créé, et le payeur et les administrateurs sont prévenus.
7. **Réponse.** Le serveur répond 200 rapidement. Les erreurs sont conservées sur la ligne de l’événement (`status='failed'`, `error`, `attempts`).

`registerPayoutWebhookHandler()` permet au module conformité de recevoir, par la même URL, les événements de versement.

## Réconciliation (tâche `payments.reconcile`)

La tâche s’exécute toutes les 60 s et peut être lancée depuis Système → Tâches. Elle :
- re-vérifie via `status()` les intentions `created` et `pending` dont l’échéance `next_check_at` est atteinte, avec un délai croissant : 1, 2, 4, 8… minutes, plafonné à 1 h ;
- expire les intentions abandonnées après une heure (`expired`). Un succès tardif confirmé par le prestataire reste honoré et réglé ;
- relance les remboursements en attente (jusqu’à 5 tentatives avec le même délai croissant). Au-delà, le remboursement passe en `failed` et l’administrateur est alerté.

L’administrateur peut aussi réconcilier un paiement ou relancer un remboursement depuis la console.

## Remboursements

Table `refunds` :
- objet : intention, commande ou campagne ;
- `amount_minor`/`currency` et équivalent en devise de référence ;
- `provider_reference`, `status` (`pending`, `processing`, `succeeded`, `failed`), `attempts`, `last_error`, `next_attempt_at`.

**Déroulement :**
1. L’écriture du grand livre (`order.refunded` ou `campaign.refunded`) est passée dans la transaction métier.
2. L’ordre `provider.refund()` est envoyé **après validation** de la transaction (`afterCommit`).
3. Les échecs sont relancés par la tâche de réconciliation.

**Fonctions exportées :**
- `refundOrderEscrow(orderId, actorId, reason)`, utilisée par le module confiance pour les litiges : rembourse intégralement l’acheteur d’une commande sandbox ou réelle encore en séquestre.
- `releaseOrderEscrow(orderId, actorId)` : verse au vendeur.

**Campagnes :**
- La clôture d’une campagne sandbox ou réelle (`POST /api/testing/campaigns/:id/close`) rembourse automatiquement le budget **non réservé**.
- Le propriétaire peut aussi le demander via `POST /api/payments/campaigns/:id/refund`.
- Le remboursement est réparti sur les paiements d’origine, du plus récent au plus ancien.

## Console d’administration (Administration → Paiements)

| Onglet | Contenu |
| --- | --- |
| Vue d’ensemble | Mode actif, équilibre du grand livre, séquestre, commissions et soldes des membres ; alertes (paiements à examiner ou non appliqués, webhooks et remboursements en échec) ; pré-requis du mode réel ; volumes encaissés ; bascule de mode |
| Prestataires | Une carte par prestataire, onglets bac à sable / production, activation, formulaire généré depuis `fields` ; secrets affichés « Configuré ••••1234 » avec Remplacer / Effacer ; problèmes de configuration ; URL de webhook à copier ; lien vers la documentation |
| Frais & devises | Commissions (en %), devise de référence (verrouillée dès la première écriture), taux de change (unités de devise pour 1 unité de référence ; XAF/XOF = 655,957 pour 1 EUR par défaut) |
| Paiements | Liste filtrable (statut, mode, prestataire, objet, à examiner, recherche) ; détail (écritures, webhooks, remboursements) ; bouton « Réconcilier » |
| Webhooks | Événements reçus, filtrables par statut et prestataire, avec l’erreur éventuelle |
| Remboursements | Suivi, tentatives, bouton « Réessayer » |
| Grand livre | Écritures et leurs lignes ; ajustement manuel (mode, devise, motif obligatoire, 2 à 10 lignes de somme nulle) |

API correspondante, réservée aux administrateurs (`requireAdmin`) ; chaque modification est auditée :

| Méthode | Route |
| --- | --- |
| GET | `/api/payments/admin/overview` |
| GET | `/api/payments/admin/providers` |
| PUT | `/api/payments/admin/providers/:id/:environment` (`{enabled, settings, secrets}` ; secret `null` ou vide = effacé, absent = conservé) |
| PUT | `/api/payments/admin/mode` (`{mode, confirmation}`) |
| GET, PUT | `/api/payments/admin/settings` (`{base_currency?, fx?, fees?}`) |
| GET | `/api/payments/admin/intents?status=&mode=&provider=&purpose=&review=1&q=&limit=&offset=` |
| GET | `/api/payments/admin/intents/:id` |
| POST | `/api/payments/admin/intents/:id/reconcile` |
| GET | `/api/payments/admin/webhooks?status=&provider=` |
| GET | `/api/payments/admin/refunds?status=` |
| POST | `/api/payments/admin/refunds/:id/retry` |
| GET | `/api/payments/admin/journals?mode=&kind=` |
| POST | `/api/payments/admin/adjustments` |

### Activer le mode réel

Le passage en `live` est refusé tant que l’une de ces conditions manque :
1. la confirmation saisie est exactement **« ACTIVER LE MODE RÉEL »** ;
2. `APP_ORIGIN` est une URL **HTTPS** publique ;
3. la variable d’environnement `ALPHA_SECRETS_KEY` est définie (chiffrement des secrets des prestataires) ;
4. au moins un prestataire réel est activé et valide pour l’environnement `live`.

**Procédure recommandée :**
1. Configurez les prestataires en bac à sable et passez en `sandbox`.
2. Faites un parcours complet : financement, webhook, mission payée, achat, livraison acceptée, litige remboursé.
3. Configurez l’environnement `live`, déclarez l’URL de webhook chez le prestataire, puis activez le mode réel.
4. Surveillez l’onglet Webhooks et les alertes pendant les premiers jours.

## Données personnelles (RGPD)

`registerPersonalData('payments', …)` :
- **Export.** Les intentions de paiement et les remboursements du membre.
- **Effacement.** Les lignes financières (intentions, remboursements, grand livre) sont **conservées** pour les obligations comptables.
  - Le téléphone masqué et l’opérateur sont effacés.
  - Les instructions et URL de redirection sont vidées, et le motif des remboursements est remplacé par « [supprimé] ».

Seul un numéro masqué (`+237•••••89`) est stocké, jamais le numéro complet.

## Cadre légal (à lire avant le mode réel)

- **Séquestre et encaissement pour compte de tiers.** Conserver l’argent d’un porteur de projet ou d’un acheteur avant de le reverser à un testeur ou un vendeur est un **service de paiement réglementé** :
  - en France et dans l’UE, DSP2 : agrément d’établissement de paiement ou de monnaie électronique, ou statut d’agent ;
  - en Afrique centrale et de l’Ouest : réglementations BEAC/COBAC et BCEAO.
  - Sans agrément, la plateforme doit s’appuyer sur un **partenaire régulé**.
- **Produits « marketplace » des prestataires.** Privilégiez Stripe Connect, les sous-comptes et paiements fractionnés Flutterwave, ou les comptes marchands des opérateurs mobile money. Les fonds restent ainsi chez le prestataire agréé : le grand livre d’Alpha sert alors de **suivi comptable**, pas de compte de cantonnement.
- **Rétrofacturations (chargebacks).** Un paiement par carte peut être contesté plusieurs mois après son versement au bénéficiaire. Prévoyez :
  - une réserve ;
  - une clause contractuelle de reprise ;
  - un ajustement manuel du grand livre en cas de rétrofacturation.
- **Validation juridique.** CGU/CGV, mandat d’encaissement, politique de remboursement, obligations LCB-FT/KYC (module conformité), TVA et DAC7 sur les commissions : à faire valider par un **avocat** et un **expert-comptable**.
- **Mobile money.** Les opérateurs imposent leurs propres contrats marchands, plafonds et délais de reversement.

## Limites connues

- **Simulateur.** Il garde ses résultats en mémoire : un redémarrage du serveur pendant un paiement simulé le laisse `pending` jusqu’à son expiration.
- **Webhooks.** Ils sont traités dans la requête et non dans une file. Un traitement en échec est enregistré, puis rattrapé par la réconciliation (`status()`) ; le webhook n’est pas rejoué.
- **Remboursements.**
  - Pas de remboursement partiel d’une commande : le remboursement est toujours intégral.
  - Pas de gestion automatique des rétrofacturations ; passez un ajustement manuel.
- **Litiges.** Le module confiance doit appeler `refundOrderEscrow` ou `releaseOrderEscrow` pour trancher un litige sur une commande sandbox ou réelle. Tant que ce branchement n’est pas fait, les fonds restent en séquestre et l’administrateur doit agir via l’API.
- **Hors périmètre.** Les retraits vers les testeurs et vendeurs (compte `user:<id>:available`) et les factures relèvent du module conformité.
- **Mobile money.** Un seul prestataire par paiement ; pas de paiement fractionné entre plusieurs moyens.
- **Taux de change.** Ils sont saisis manuellement, sans mise à jour automatique.
