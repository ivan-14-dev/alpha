# Conformité : portefeuille, KYC, versements, factures et fiscalité (V4)

Ce module couvre tout ce qui se passe **après** qu’un membre a gagné de l’argent sur Alpha (récompense de mission de test, vente sur la
marketplace) :
- consulter son solde et ses mouvements ;
- prouver son identité (KYC) ;
- enregistrer un moyen de versement (mobile money, compte bancaire, Stripe Connect) ;
- demander un retrait, que la plateforme verse par l’intermédiaire d’un prestataire de paiement ;
- recevoir des reçus, factures de commission et relevés de versement numérotés de façon continue.

Côté administration, l’équipe conformité dispose :
- de la file des dossiers KYC et de la file des retraits ;
- des réglages de limites, de tentatives, de TVA et d’identité de l’émetteur ;
- de la liste des documents émis ;
- d’un export comptable CSV.

> **Avertissement.** Les seuils, taux, mentions et modèles de documents fournis sont des **points de départ techniques**. Ils doivent être
> validés par un **expert-comptable** et un **avocat** (droit bancaire et financier, fiscalité, protection des données) avant toute
> exploitation en mode réel. Voir la section « Cadre légal » plus bas.

## Fichiers du module

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/008-compliance.sql` |
| API (`/api/compliance`) + tâches planifiées | `server/modules/compliance.ts` |
| Réglages (limites, tentatives, TVA, émetteur) | `server/compliance/settings.ts` |
| Vérification d’identité | `server/compliance/kyc.ts` |
| Moyens de versement (validation, scellement, masquage) | `server/compliance/payoutMethods.ts` |
| Retraits, file d’attente, tâche de versement | `server/compliance/withdrawals.ts` |
| Factures, reçus, relevés, export CSV | `server/compliance/invoices.ts` |
| Portefeuille (soldes, mouvements, limites) | `server/compliance/wallet.ts` |
| RGPD (export / effacement) | `server/compliance/privacy.ts` |
| Utilitaires (échappement HTML, cellules CSV, montants) | `server/compliance/util.ts` |
| Page membre `/wallet` | `src/pages/WalletPage.tsx` |
| Composants (assistant KYC, moyens de versement, statuts) | `src/components/KycForm.tsx`, `src/components/PayoutMethodForm.tsx`, `src/components/PayoutMethodList.tsx`, `src/components/PayoutStatus.tsx` |
| Console admin « Conformité » (`/admin/compliance`) | `src/admin/ComplianceAdmin.tsx` |
| Styles | `src/styles/compliance.css` |
| Tests | `tests/compliance-v4.test.ts` |

## Modes de paiement

Le comportement dépend du réglage `payments.mode`, lu avec `paymentMode()` :

| Mode | Portefeuille | Retraits | Documents |
| --- | --- | --- | --- |
| `demo` | Charge utile `{ mode: 'demo' }` sans grand livre ; la page explique que les gains sont fictifs. | Refusés (409). | Aucun. |
| `sandbox` | Soldes réels du grand livre **sandbox**. | Versés par les prestataires de test (simulateur). | Série `ALPHA-SBX-<AAAA>-<000001>`, marqués « SPÉCIMEN, sans valeur comptable ni fiscale ». |
| `live` | Soldes réels du grand livre **live**. | Versés par les prestataires réels activés. | Série `ALPHA-<AAAA>-<000001>`. Émission **bloquée** tant que l’émetteur est incomplet. |

Les écritures, retraits et factures portent tous leur `mode`. Les séries sandbox et live ne se mélangent jamais.

## Modèle de données (migration 008)

| Table | Contenu |
| --- | --- |
| `kyc_profiles` | Un dossier par utilisateur (clé `user_id`) : statut `draft`, `submitted`, `approved` ou `rejected` ; niveau `none`, `standard` ou `enhanced` ; nom légal, pays ISO 3166-1 alpha-2, date de naissance ; adresse **scellée** (JSON chiffré) ; identifiants des pièces (JSON, fichiers d’usage `kyc_document` rattachés à `kyc/<userId>`) ; dates d’envoi et de revue, réviseur, motif de refus. |
| `payout_methods` | Moyens de versement : type `mobile_money`, `bank_account` ou `stripe_connect`, prestataire, libellé ; coordonnées **scellées** (contexte `payout:<id>`), aperçu masqué, pays, devise ; empreinte (détection d’un même compte partagé entre plusieurs utilisateurs), défaut, date du premier versement réussi, suppression logique. |
| `withdrawals` | Demandes de retrait. Montants : en devise de base (`amount_base_minor`, `base_currency`) et en devise de versement (`amount_minor`, `currency`, conversion `payoutFromBase`). Exécution : moyen, prestataire, mode, statut, niveau de risque, motif de mise en attente, revue (note, réviseur, date), référence chez le prestataire, motif d’échec, nombre de tentatives, prochaine tentative, clé d’idempotence, horodatages. |
| `invoices` | Documents émis : numéro unique, série, année, rang ; utilisateur ; type `receipt`, `commission` ou `payout_statement` ; écriture d’origine (`journal_id` **unique par type**) ; devise ; montants HT, TVA et TTC ; taux en points de base ; instantanés JSON de l’émetteur et du client ; date d’émission. Rendus **immuables** par des déclencheurs SQL. |
| `invoice_counters` | Compteur par `(series, year)`. L’incrément a lieu dans la même transaction que l’insertion de la facture, ce qui garantit une numérotation **continue et sans trou**. |
| `compliance_cursors` | Curseur de la tâche de facturation : dernier `rowid` traité dans `ledger_journals`. |

Toutes les clés étrangères vers `users` sont en `ON DELETE RESTRICT` pour les retraits et les factures (conservation légale, voir RGPD).

## Grand livre : écritures produites par le module

Les montants sont en unités mineures de la **devise de base**. Toutes les écritures passent par `postJournal` (équilibrées, idempotentes).

| Écriture | Débit (−) | Crédit (+) | Contrôle |
| --- | --- | --- | --- |
| `withdrawal.requested` | `user:<id>:available` | `withdrawals:in_flight` | `nonNegative` sur le disponible : solde insuffisant → 409, rien n’est écrit. |
| `withdrawal.paid` | `withdrawals:in_flight` | `provider:<prestataire>` | Versement confirmé par le prestataire. |
| `withdrawal.cancelled` | `withdrawals:in_flight` | `user:<id>:available` | Annulation par le membre (statuts `requested`, `on_hold`, `approved`). |
| `withdrawal.rejected` | `withdrawals:in_flight` | `user:<id>:available` | Refus par un administrateur. |
| `withdrawal.failed` | `withdrawals:in_flight` | `user:<id>:available` | Échec définitif après les tentatives. |

Le module **lit** aussi les écritures du module paiements pour la facturation : `campaign.funded`, `order.paid`, `mission.paid`,
`order.released`.

## API (`/api/compliance`)

Toutes les routes exigent une session (`requireUser`). Les routes `/admin/*` exigent `requireAdmin`, et chaque action d’administration est
journalisée (`audit`). Les écritures passent par la protection CSRF commune.

### Membre

| Méthode et chemin | Effet |
| --- | --- |
| `GET /wallet` | Mode, devise de base, soldes (disponible, en attente, retraits en cours), 50 derniers mouvements, statut KYC, moyens masqués, 20 derniers retraits, limites restantes (24 h / 30 jours / montant sans KYC), 20 derniers documents, e-mail vérifié. En démo : `{ mode: 'demo', … }` sans grand livre. |
| `GET /kyc` · `PUT /kyc` | Lecture / enregistrement du brouillon (capacité `money`). Pièces : fichiers de l’utilisateur, d’usage `kyc_document`, rattachés à `kyc/<userId>`. |
| `POST /kyc/submit` | Envoi pour vérification (10 par heure). Exige les champs complets, au moins 18 ans, au moins une pièce, et aucune pièce en analyse ou refusée par l’antivirus (`scan_status` `clean` ou `skipped`). |
| `GET /payout-methods` | Liste masquée, avec `payout_available` (un prestataire actif peut-il verser ce moyen dans cette devise). |
| `POST /payout-methods` | Création (capacité `withdraw`, 10 par heure). Validation : mobile money (numéro E.164 et opérateur connu), banque (IBAN avec contrôle mod 97, ou numéro de compte et code banque), Stripe Connect (`acct_…`). |
| `PATCH /payout-methods/:id` | Libellé. |
| `POST /payout-methods/:id/default` | Définit le moyen par défaut. |
| `DELETE /payout-methods/:id` | Suppression logique (204). Refusée si un retrait en cours l’utilise. |
| `GET /withdrawals` | Historique paginé. |
| `POST /withdrawals` | Demande `{ amount_minor, payout_method_id, idempotency_key? }` (capacité `withdraw`, 20 par heure). Renvoie 201, ou 200 en cas de rejeu de la même clé. |
| `POST /withdrawals/:id/cancel` | Annulation tant que le versement n’a pas commencé ; les fonds sont recrédités. |
| `GET /invoices` | Mes documents. |
| `GET /invoices/:id/html` | Version imprimable (propriétaire ou admin). HTML entièrement échappé, CSP dédiée sans script (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. La consultation par un admin est auditée. |

### Administration (`/admin/*`)

| Méthode et chemin | Effet |
| --- | --- |
| `GET /admin/summary` | Compteurs (dossiers à examiner, retraits en attente, approuvés, en cours, échecs sur 30 j, documents émis), mode, devise de base, problèmes de l’émetteur, facturation bloquée. |
| `GET /admin/kyc?status=` | File KYC (`submitted` par défaut). |
| `GET /admin/kyc/:userId` | Dossier complet, adresse déchiffrée et liens de téléchargement `/api/files/:id/download`. La consultation est journalisée, et le module fichiers journalise chaque téléchargement. |
| `POST /admin/kyc/:userId/approve` | `{ level: 'standard' \| 'enhanced', note }`. Interdit sur son propre dossier. L’utilisateur est notifié. |
| `POST /admin/kyc/:userId/reject` | `{ reason }` (5 caractères au moins), communiqué à l’utilisateur, qui peut corriger et renvoyer. |
| `GET /admin/withdrawals?status=open\|all\|<statut>` | File des retraits, avec niveau de risque, motif de mise en attente et statut KYC. |
| `POST /admin/withdrawals/:id/approve` | Retraits `requested` ou `on_hold` (pas les siens). |
| `POST /admin/withdrawals/:id/reject` | `{ reason }`. Possible tant que le versement n’a pas commencé. Recrédite les fonds (`withdrawal.rejected`). |
| `POST /admin/withdrawals/:id/retry` | Relance immédiate d’un retrait `approved`, ou d’un retrait `processing` déjà connu du prestataire (vérification du statut). |
| `GET /admin/settings` · `PUT /admin/settings/:name` | `name` ∈ `limits`, `payout_retry`, `tax`, `issuer`. |
| `GET /admin/invoices?from=&to=&kind=` | Tous les documents émis. |
| `GET /admin/exports/journals.csv?from=&to=&mode=&sep=` | Export comptable (voir plus bas). |

Les tâches peuvent aussi être lancées depuis la console via `POST /api/system/admin/jobs/:name/run` (module système).

## Réglages

Tous les montants sont en unités mineures de la **devise de base** (centimes d’euro par défaut).

| Clé | Valeur par défaut | Rôle |
| --- | --- | --- |
| `compliance.limits` | `kyc_required_above_minor: 15000` · `min_withdrawal_minor: 1000` · `daily_limit_minor: 100000` · `monthly_limit_minor: 500000` · `manual_review_above_minor: 50000` | KYC obligatoire au-delà de 150 € de retraits cumulés sur 30 jours (demande en cours comprise) ; minimum 10 € ; plafonds glissants de 1 000 € sur 24 h et 5 000 € sur 30 jours ; revue manuelle de tout retrait de plus de 500 €. Contrainte : minimum ≤ plafond 24 h ≤ plafond 30 j. |
| `compliance.payout_retry` | `max_attempts: 4` · `base_delay_seconds: 300` · `status_check_seconds: 300` | Tentatives après un refus du prestataire. Délai exponentiel (5 min, 10 min, 20 min…, 24 h au plus). Les versements « en attente » sont vérifiés toutes les 5 min. |
| `compliance.tax` | `default_rate_bps: 2000` · `rates: {}` · `prices_include_tax: true` · `exemption_mention: ''` | TVA appliquée à la **commission** selon le pays KYC du bénéficiaire (ex. `{ "CM": 1925, "SN": 1800 }`). Si `prices_include_tax` vaut true, la TVA est extraite de la commission prélevée. Si l’écriture contient une jambe `platform:taxes`, elle fait foi. |
| `compliance.issuer` | Tous les champs vides | Raison sociale, forme juridique et capital, adresse, immatriculation (SIREN/RCS ou RCCM), n° de TVA ou NIU, e-mail, mentions de bas de page. Raison sociale, adresse et immatriculation sont **obligatoires** pour émettre en mode live. |

## Retraits

### Contrôles à la demande (`POST /withdrawals`)

Dans l’ordre :
1. Mode `sandbox` ou `live` (sinon 409), puis capacité `withdraw` (restrictions du module confiance).
2. **E-mail vérifié** (`users.email_verified_at`, sinon 403), puis moyen de versement appartenant au membre et non supprimé (sinon 404).
3. Rejeu de la clé d’idempotence : la demande existante est renvoyée, sans nouvelle écriture.
4. Montant minimum (400), conversion `payoutFromBase` vers la devise du moyen, puis prestataire actif capable de verser ce type de moyen dans cette devise (409).
5. Le reste se fait dans **une seule transaction** :
   - plafonds 24 h et 30 jours (409) ;
   - **KYC approuvé** si le cumul sur 30 jours dépasse le seuil (403) ;
   - motifs de mise en attente :
     - `riskLevel(user)` vaut `high` ;
     - le montant dépasse le seuil de revue manuelle ;
     - le moyen de versement est déjà enregistré par un autre compte (même empreinte) ;
   - écriture `withdrawal.requested`, avec contrôle de solde non négatif (409 si insuffisant) ;
   - insertion du retrait en `on_hold` s’il y a un motif, sinon en `approved` ;
   - notification du membre.
6. Signal `recordSignal('withdrawal')` (anti-fraude), après la transaction.

### Cycle de vie

```
requested ─┐
           ├─▶ on_hold ──(admin approuve)──▶ approved ──(tâche)──▶ processing ──▶ paid
           └──────────────────────────────▶ approved                    │
on_hold / requested / approved ──(membre)──▶ cancelled  (fonds recrédités)
on_hold / requested / approved ──(admin)───▶ rejected   (fonds recrédités)
processing ──(refus prestataire, tentatives épuisées)──▶ failed (fonds recrédités)
processing ──(résultat inconnu, tentatives épuisées)───▶ on_hold (SANS recrédit, contrôle manuel)
```

### Tâche `compliance.payouts` (toutes les minutes)

1. **Réservation atomique** : `UPDATE … SET status='processing' WHERE id=? AND status='approved'`. Une seule instance traite chaque retrait,
   même avec plusieurs serveurs.
2. Appel `provider.payout(...)` **hors transaction**. Le moyen est déchiffré au dernier moment. La configuration vient de
   `readProviderConfig` et `providerContext`. Référence idempotente : l’identifiant du retrait, suffixé `-r<n>` uniquement après un refus explicite.
3. Selon le résultat :
   - **succès** : écriture `withdrawal.paid`, statut `paid` et notification ;
   - **en attente** : vérification ultérieure par `provider.status('payout', référence)` ;
   - **refus explicite** du prestataire : nouvelle tentative avec délai exponentiel ; au-delà de `max_attempts`, statut `failed`, écriture `withdrawal.failed`, fonds recrédités et notification ;
   - **erreur inconnue** (délai dépassé, réseau) : nouvelle tentative **avec la même référence**, pour que le prestataire déduplique ; au-delà de `max_attempts`, statut `on_hold` **sans recrédit**.
4. Un retrait resté `processing` plus de 15 minutes **sans référence prestataire** (plantage avant l’appel) repasse en `approved`.

> **Écart volontaire à la spécification initiale.** Un échec « inconnu » ne recrédite pas automatiquement : le versement a pu être
> exécuté chez le prestataire. Recréditer entraînerait alors un **double paiement**. L’administrateur vérifie chez le prestataire, puis
> utilise « Relancer » (si le versement est connu) ou « Rejeter » (s’il n’a pas eu lieu).

**Webhooks de versement.** Au chargement, le module enregistre `handlePayoutWebhook` auprès de `server/payments/webhooks.ts`
(`registerPayoutWebhookHandler`). Les webhooks de type `payout` dont la signature a été vérifiée par le module paiements sont rapprochés
d’un retrait `processing` du même prestataire et du même mode, à partir de l’identifiant du retrait, de la référence de versement ou de la
référence prestataire. Le contenu du webhook n’est **jamais** pris pour argent comptant : le statut est reconfirmé par
`provider.status('payout')` avant tout journal. Si le webhook arrive avant la réponse de l’appel `payout` (aucune référence prestataire
encore connue), c’est le job qui fera le rapprochement. `payoutWebhookHint(reference)` reste disponible pour programmer une vérification
au prochain passage du job.

## Factures, reçus et relevés

### Tâche `compliance.invoices` (toutes les 5 minutes)

La tâche parcourt les nouvelles écritures de `ledger_journals` à partir de son curseur et émet :

| Écriture | Document | Destinataire | Montants |
| --- | --- | --- | --- |
| `campaign.funded`, `order.paid` | **Reçu** (`receipt`) | Le payeur (`payment_intents.user_id`, l’écriture référençant `payment_intent`) | Montant placé sous séquestre, sans TVA. Ce n’est pas un chiffre d’affaires d’Alpha. |
| `mission.paid`, `order.released` | **Facture de commission** (`commission`) | Le bénéficiaire (jambe `user:<id>:available` créditée) | Jambe `platform:fees`. TVA extraite selon `compliance.tax`, ou jambe `platform:taxes` si elle existe. |
| `withdrawal.paid` | **Relevé de versement** (`payout_statement`) | Le membre | Montant versé, sans TVA. |

Garanties :
- **Une seule fois** : contrainte `UNIQUE(kind, journal_id)`, idempotente même si la tâche est relancée.
- **Numérotation continue** : chaque émission se fait dans un point de sauvegarde (savepoint). Une erreur annule aussi l’incrément du compteur, donc aucun numéro n’est « brûlé ».
- **Immuabilité** : les déclencheurs SQL interdisent `UPDATE` et `DELETE` sur `invoices`.
- **Instantanés** : l’émetteur et le client sont figés au moment de l’émission, et une modification ultérieure des réglages ne change pas les documents déjà émis.
- **Live bloqué** si l’émetteur est incomplet. Le curseur s’arrête sur la première écriture live, et la console affiche « Émetteur des factures incomplet ».
- **Écriture invalide** : elle est journalisée et ignorée, pour ne pas bloquer le flux comptable.

### Export comptable CSV

`GET /api/compliance/admin/exports/journals.csv?from=AAAA-MM-JJ&to=AAAA-MM-JJ&mode=live|sandbox&sep=semicolon|comma` produit **une ligne
par jambe d’écriture**. Colonnes :
- identifiant d’écriture, date, type, mode, devise ;
- référence (type et identifiant), libellé ;
- compte, montant en unités mineures ;
- numéros des documents émis.

Le fichier est **protégé contre l’injection de formules** (OWASP CSV injection) :
- toute cellule texte commençant par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée par `'` ;
- toutes les cellules texte sont entre guillemets, avec les guillemets doublés.

La période est limitée à 366 jours et chaque export est audité.

## Sécurité

- **Scellement** : l’adresse KYC et les coordonnées de versement sont chiffrées avec `seal()` (contexte `payout:<id>` pour les moyens).
  Elles ne sont jamais renvoyées en clair au membre : seuls des aperçus masqués le sont (`MTN MoMo ••••0001`, `FR76 •••• 0189`, `acct_••••1234`).
- **Pièces KYC** : elles passent par le module fichiers (chiffrement au repos, antivirus, journal d’accès). Tant que le dossier n’a jamais été
  envoyé, « Retirer » détache la pièce puis la supprime (`DELETE /api/files/:id`). Une fois le dossier envoyé, la pièce est conservée au titre
  des obligations légales (refus 409 du module fichiers) et seulement détachée du dossier. Seuls les administrateurs y accèdent.
- **Autorisations** : un membre ne voit que ses propres données. Un administrateur ne peut ni approuver son propre KYC ni ses propres retraits.
- **Idempotence** : il y en a à chaque étage (clé de demande, écritures `postJournal`, référence de versement, `UNIQUE(kind, journal_id)` des factures).
- **Limitation de débit** : envoi KYC, création de moyens et demandes de retrait.
- **HTML imprimable** : échappement systématique et CSP sans script. La page d’impression ne charge aucune ressource externe.

## RGPD (`registerPersonalData('compliance', …)`)

- **Export** :
  - dossier KYC (champs déclarés et liste des pièces, **sans leur contenu**) ;
  - moyens de versement **masqués** ;
  - retraits ;
  - documents émis ;
  - mention de la durée de conservation.
- **Effacement** :
  - **ce qui est effacé** : nom légal, pays, date de naissance, adresse scellée, références des pièces, motif de refus, coordonnées scellées, aperçus et libellés des moyens ;
  - **ce qui est conservé** : les retraits et les documents comptables, **10 ans** (Code de commerce, art. L123-22 ; livre des procédures fiscales, art. L102 B) ;
  - le statut KYC est conservé comme trace de conformité ;
  - les fichiers des pièces sont supprimés selon la politique de conservation du module fichiers.
- **Point d’attention LCB-FT** : si Alpha est elle-même assujettie aux obligations anti-blanchiment (voir ci-dessous), les éléments
  d’identification doivent être conservés **5 ans** après la fin de la relation (CMF, art. L561-12), **même en cas de demande
  d’effacement**. Il faut alors un gel légal (« legal hold ») au lieu d’un effacement immédiat. Ce choix revient au DPO et au conseil
  juridique. La version actuelle efface immédiatement, en considérant que la KYC réglementaire est portée par le prestataire de paiement.

## Cadre légal : points à valider

> Cette section **n’est pas un avis juridique**. Elle liste les sujets à faire valider avant d’ouvrir le mode réel.

### KYC et lutte contre le blanchiment (LCB-FT)

- **Prestataire ou plateforme ?** Une plateforme qui encaisse des fonds pour le compte de tiers (séquestre, puis reversement aux
  testeurs ou vendeurs) fournit en principe un **service de paiement**. Cela exige un agrément d’établissement de paiement ou de
  monnaie électronique auprès de l’ACPR (directive (UE) 2015/2366 « DSP2 », directive 2009/110/CE, Code monétaire et financier). À défaut
  d’agrément, la voie usuelle est de s’appuyer sur un **prestataire agréé proposant un mode « marketplace »** (Stripe Connect, Mangopay,
  Lemonway…), en tant qu’agent ou partenaire. Dans ce cas :
  - les fonds sont détenus et **cantonnés** par le prestataire ;
  - la **KYC réglementaire** des bénéficiaires est réalisée par le prestataire ;
  - la KYC d’Alpha est une mesure **complémentaire**, fondée sur les risques (fraude, abus, sanctions), qui ne remplace pas celle du prestataire.
- Les établissements assujettis (CMF, art. L561-2) doivent :
  - identifier et vérifier l’identité ;
  - appliquer une vigilance adaptée au risque ;
  - déclarer les soupçons à TRACFIN ;
  - filtrer les gels d’avoirs et les sanctions ;
  - conserver les données 5 ans.

  Le module fournit les outils (dossier, pièces, revue, journal, plafonds), mais **pas** le filtrage des listes de sanctions ni la
  déclaration de soupçon.
- **Afrique centrale et de l’Ouest** :
  - en CEMAC, les services de paiement et la monnaie électronique (dont le mobile money) relèvent de la **BEAC et de la COBAC** (règlement relatif aux services de paiement dans la CEMAC) ;
  - la LCB-FT y est encadrée par le règlement CEMAC dédié, avec l’ANIF comme cellule de renseignement financier ;
  - en UEMOA, ces sujets relèvent de la **BCEAO** et de la CENTIF ;
  - les versements mobile money doivent passer par des agrégateurs ou opérateurs autorisés localement.
- Les seuils par défaut (KYC au-delà de 150 € sur 30 jours, revue au-delà de 500 €) sont **arbitraires**. Ils doivent découler de la
  classification des risques de l’entreprise et des exigences du prestataire.

### Cantonnement des fonds

Les soldes affichés dans le portefeuille sont des **créances** des membres. Sans agrément, Alpha ne doit **pas détenir** ces fonds sur
ses propres comptes : ils doivent rester chez le prestataire agréé, sur des comptes cantonnés. Le grand livre d’Alpha est un **registre
de suivi**, pas un compte de paiement. En mode réel, il doit être rapproché régulièrement des relevés du prestataire.

### Factures : mentions en France

- **Numérotation** unique, fondée sur une séquence **chronologique et continue**. Plusieurs séries sont admises si elles sont justifiées
  (par exemple par année) (CGI, art. 242 nonies A ; BOFiP TVA). Alpha utilise une série par année et une série séparée pour la sandbox.
  - Reçus, factures de commission et relevés **partagent** la même séquence. Si l’expert-comptable préfère des séries distinctes par type de document, l’évolution est simple (colonne `series`).
- **Mentions obligatoires** (CGI, art. 242 nonies A ; Code de commerce, art. L441-9) :
  - identité de l’émetteur (raison sociale, forme et capital, adresse, SIREN/RCS, n° de TVA intracommunautaire) ;
  - identité du client et, pour un professionnel, son n° de TVA ;
  - date, numéro et désignation ;
  - montants HT, taux et montant de TVA, TTC ;
  - date d’exigibilité ;
  - pour les professionnels : **pénalités de retard** et **indemnité forfaitaire de recouvrement de 40 €** (Code de commerce, art. D441-5).

  Certaines mentions sont saisies dans le réglage `compliance.issuer` (bas de page).
- **Mentions particulières** :
  - « TVA non applicable, art. 293 B du CGI » (franchise en base) ;
  - « Autoliquidation » pour les prestations B2B intracommunautaires.

  Elles se saisissent dans `exemption_mention`.
- **Corrections** : une facture émise ne se modifie pas. Toute correction passe par une **facture rectificative ou un avoir**, qui
  **n’est pas encore implémenté**.
- **Facturation électronique** : la réforme impose, à partir du 1er septembre 2026, la **réception** de factures électroniques à toutes
  les entreprises et l’**émission** aux grandes entreprises et ETI ; les PME et micro-entreprises émettent à partir de 2027. Elle impose
  aussi le **e-reporting** des opérations B2C et internationales. Les documents HTML d’Alpha ne sont **pas** des factures électroniques au
  sens de la réforme (Factur-X, UBL, CII), et les factures B2B devront transiter par une **plateforme agréée**.
- **Qualification de l’intermédiaire** : selon les conditions générales, Alpha agit en **intermédiaire transparent** ou en
  **commissionnaire opaque** (CGI, art. 256 V). Dans le premier cas, seule sa commission est taxable. Dans le second, la TVA porte sur le
  montant total. Le modèle actuel (reçu de séquestre au payeur, facture de commission au bénéficiaire) suppose un intermédiaire
  transparent.

### Zone OHADA, CEMAC et UEMOA

- **Comptabilité** : AUDCIF et **SYSCOHADA révisé**. La numérotation continue et la conservation (10 ans) sont aussi exigées.
- **Mentions usuelles** :
  - n° **RCCM** ;
  - **NIU** (Cameroun) ou NINEA (Sénégal) ;
  - régime d’imposition ;
  - centre des impôts de rattachement.

  À saisir dans `compliance.issuer`.
- **TVA** :
  - Cameroun : **19,25 %** (17,5 % plus centimes additionnels communaux) ;
  - Sénégal et Côte d’Ivoire : **18 %** ;
  - Gabon : **18 %** ;
  - plusieurs États taxent désormais les **services numériques fournis par des entreprises étrangères**, ce qui peut imposer une immatriculation locale ou une retenue par l’opérateur de paiement.

  À configurer dans `compliance.tax.rates` après validation.

### TVA dans l’Union européenne

Pour une commission facturée à un **particulier** de l’UE pour un service fourni par voie électronique, la TVA est due **dans le pays du
client**. Le guichet unique **OSS** permet de la déclarer depuis la France. Pour un **professionnel** de l’UE, la règle est
l’autoliquidation. Le module applique le taux du pays de résidence KYC du bénéficiaire, ou le taux par défaut. Il ne distingue **pas
encore** B2B et B2C (pas de collecte ni de vérification VIES du n° de TVA du membre).

### DAC7 et obligations déclaratives des plateformes

- La **directive (UE) 2021/514 (DAC7)**, transposée en France aux articles 1649 ter A et suivants du CGI, impose aux opérateurs de
  plateforme de collecter des informations sur les **vendeurs** de biens et de **services personnels**. Les missions de test rémunérées
  entrent probablement dans ce périmètre. Les informations à collecter :
  - identité, adresse, date de naissance ;
  - NIF ;
  - IBAN ;
  - montants bruts, commissions et nombre d’opérations par trimestre.
- Elles sont déclarées chaque année à la DGFiP avant le **31 janvier**, et une copie est remise aux vendeurs.
- L’article **242 bis du CGI** impose en outre d’informer les utilisateurs de leurs obligations fiscales et de leur adresser un
  **récapitulatif annuel** des sommes perçues.
- Le module fournit les données sources (KYC, moyens de versement, grand livre, export CSV). Il ne produit **pas** encore la déclaration
  DAC7 (format XML DGFiP) ni le récapitulatif annuel.

## Tests

`npx tsx --test tests/compliance-v4.test.ts` (mode sandbox, prestataire simulateur, et un prestataire « défaillant » enregistré par le
test avec `registerProvider`) couvre :
- le parcours KYC complet et la revue admin, ainsi que le masquage et le scellement des moyens ;
- le retrait nominal par `runJob('compliance.payouts')` ;
- les refus : solde insuffisant (409), plafonds, KYC requis, e-mail non vérifié ;
- la mise en attente pour revue, le refus avec recrédit, l’annulation, puis les tentatives et le recrédit après échec ;
- l’équilibre du grand livre (`ledgerIsBalanced`) ;
- les factures émises une seule fois avec numéros consécutifs ;
- l’échappement CSV et HTML, ainsi que les contrôles d’autorisation.

## Limites connues

- Pas d’aperçu du taux de change côté client avant la demande : le montant exact dans la devise de versement apparaît dans l’historique.
- Pas d’avoir ni de facture rectificative, pas de distinction B2B/B2C (VIES), et pas de générateur DAC7 ni de récapitulatif annuel 242 bis.
- Pas de filtrage automatique des listes de sanctions ni de vérification documentaire automatisée (OCR, liveness) : la revue est manuelle.
- Les factures ne sont pas des factures électroniques au format structuré (Factur-X, UBL).
- Le versement par virement bancaire dépend d’un prestataire réel qui le prend en charge. Selon sa configuration, le simulateur peut ne
  couvrir que le mobile money et Stripe Connect : le moyen est alors signalé « Indisponible ».
