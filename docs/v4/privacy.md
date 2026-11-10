# Protection des données (RGPD) et documents légaux (V4)

Ce module fournit les outils dont Alpha a besoin pour respecter le RGPD et la loi Informatique et Libertés :

- l’export des données ;
- la suppression du compte, avec un délai de grâce ;
- les consentements, versionnés et historisés ;
- les durées de conservation, appliquées par un job ;
- les documents légaux (modèles), avec preuve d’acceptation ;
- le registre des traitements et le registre des violations ;
- une console d’administration.

> Le code applique les règles. La conformité juridique reste de la responsabilité de l’exploitant.
> Les modèles de `docs/legal/` portent la mention **« Modèle à faire valider par un juriste »**.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/013-privacy.sql` : `privacy_requests`, `consents`, `consent_events` (immuable), `breach_register` |
| API | `server/modules/privacy.ts` (`/api/privacy/*` et `/api/privacy/admin/*`) |
| Réglages | `server/privacy/settings.ts` : `privacy.controller` et `privacy.retention` |
| Consentements | `server/privacy/consents.ts` : `hasConsent()`, `setConsents()`, `withdrawAllConsents()` |
| Export | `server/privacy/export.ts` : archive construite à la demande |
| Suppression | `server/privacy/erasure.ts` : blocages, anonymisation, exécution |
| Cycle de vie des demandes | `server/privacy/requests.ts` |
| Conservation | `server/privacy/retention.ts` |
| Documents légaux | `server/privacy/legal.ts` et `server/privacy/markdown.ts` (analyseur Markdown sûr, sans HTML) |
| Registres | `server/privacy/register.ts` (traitements) et `server/privacy/breaches.ts` (violations) |
| Jobs et données propres | `server/privacy/jobs.ts` |
| Réauthentification | `server/privacy/reauth.ts` |
| Modèles juridiques | `docs/legal/*.md` |
| Interface | `src/pages/LegalPage.tsx` (`/legal/:doc`), `src/components/PrivacyControls.tsx` (Paramètres, ancre `#privacy`), `src/admin/PrivacyAdmin.tsx` (`/admin/privacy`), `src/styles/privacy.css` |
| Tests | `tests/privacy-v4.test.ts` |

## Correspondance RGPD → fonctionnalités

| Article | Exigence | Mise en œuvre |
| --- | --- | --- |
| 5.1.c | Minimisation | L’export exclut les secrets. La suppression efface le profil. Les journaux ne contiennent pas de mot de passe. |
| 5.1.e | Limitation de la conservation | Job `privacy.retention`, réglage `privacy.retention`, simulation (dry-run) dans la console. |
| 5.2 | Responsabilité (accountability) | Toutes les actions d’administration RGPD passent par `audit()`. Les décisions sont historisées dans `privacy_requests` et `consent_events`. |
| 6 | Bases légales | Elles sont listées par finalité dans `confidentialite.md` et dans le registre généré. |
| 7 | Conditions du consentement | Les consentements sont désactivés par défaut et retirables aussi facilement qu’ils ont été donnés. Chaque changement est horodaté (`consent_events`), avec la version de la politique et la source. |
| 12 | Modalités, délai d’un mois | Chaque demande a une date limite de réponse (`response_deadline`) et un indicateur de retard dans la file d’administration. Les refus sont motivés, le motif fait au moins 10 caractères et il est notifié. |
| 13 / 14 | Information | `/legal/privacy` présente l’identité du responsable (tirée des réglages), les finalités, les destinataires, les transferts, les durées et les droits. |
| 15 / 20 | Accès et portabilité | Archive JSON structurée (`format: alpha.personal-data-export`), téléchargeable 7 jours. |
| 16 | Rectification | Le profil est modifiable par le membre (module people et comptes). |
| 17 | Effacement | Demande avec mot de passe ou connexion récente, puis délai de grâce de 30 jours et annulation possible. L’anonymisation est exécutée par le job `privacy.erasure`. |
| 17.3.b / e | Exceptions | Le grand livre, les transactions, les factures, les retraits, les acceptations légales et l’audit sont conservés, rattachés à l’identifiant anonymisé. |
| 18 / 21 | Limitation et opposition | Retrait des consentements, préférences de notification (module realtime), suppression du compte. Les autres demandes passent par le DPO, par e-mail. |
| 25 | Protection dès la conception | Aucun cookie non essentiel. Consentements à 0 par défaut. Archive jamais stockée. Le HTML brut des documents n’est jamais interprété. |
| 30 | Registre des traitements | Généré à partir des traitements cœur et des descriptions des modules. Consultable dans la console et téléchargeable en JSON (`/api/privacy/admin/register/download`). |
| 32 | Sécurité | Sessions hachées, réauthentification avant la suppression, limitation de débit sur l’export et la suppression, `Cache-Control: no-store` sur l’archive. |
| 33 / 34 | Violations | Registre des violations avec un indicateur du délai de 72 h pour la CNIL et un rappel d’information des personnes si le risque est élevé. |
| 35 | AIPD (DPIA) | Voir la section « Notes AIPD » plus bas. |
| 77 | Réclamation | La politique de confidentialité indique la CNIL (cnil.fr/plaintes). |

## Parcours membre

### Export (art. 15 et 20)

1. `POST /api/privacy/exports` crée la demande. La limite est d’un export par 24 h ; au-delà, l’API renvoie 429 avec l’en-tête `Retry-After`. Le traitement est immédiat. Le job `privacy.exports` (toutes les 5 minutes) reprend les demandes en attente.
2. Le membre reçoit une notification et un e-mail : « Votre export est prêt ».
3. `GET /api/privacy/exports/:id/download` sert l’archive :
   - réservé au propriétaire ; un autre membre reçoit 404 ;
   - disponible pendant 7 jours (410 ensuite) ;
   - en-têtes `Content-Disposition: attachment` et `Cache-Control: no-store, private`.

L’archive est reconstruite à chaque téléchargement et n’est jamais stockée.

**Sections cœur de l’archive :**

- account, sessions (métadonnées uniquement), organizations, projects, project_tasks ;
- campaigns, applications, missions, missions_on_my_campaigns ;
- community (publications, commentaires, j’aime, groupes), network ;
- messages : uniquement les messages envoyés par le membre, plus les identifiants de ses conversations ;
- marketplace (annonces, achats, ventes) ;
- reviews : avis écrits, et partie publique des avis reçus ;
- moderation_reports, notifications, emails (métadonnées) ;
- audit_events (actions dont le membre est l’auteur) ;
- demo_transactions ;
- ledger_entries (écritures de ses comptes) ;
- legal_acceptances ;
- files (métadonnées).

**Données des modules.** S’y ajoutent, sous `modules.<nom>`, les données de chaque gestionnaire `registerPersonalData()` avec leur description.

**Robustesse.** Chaque section est isolée : un échec n’apparaît que dans `errors[]` et n’empêche pas le reste de l’export.

**Ce que l’archive ne contient jamais :**

- empreintes de mot de passe et jetons de session ;
- secrets et champs scellés ;
- corps des messages des autres membres ;
- e-mails des autres membres.

Un filtre `stripSecrets` retire en plus toute clé sensible (`password_hash`, `token_hash`, `secret`, `sealed`…) que renverrait un module.

### Suppression du compte (art. 17)

**Faire la demande.** `POST /api/privacy/erasure` attend :

- la confirmation `SUPPRIMER` ;
- le mot de passe, ou une connexion de moins de 10 minutes pour les comptes créés par OAuth sans mot de passe.

La demande fixe `scheduled_for` à maintenant + 30 jours. Un e-mail de confirmation part, avec une notification.

**Annuler.** `DELETE /api/privacy/erasure` annule la demande pendant le délai de grâce.

**Blocages.** Ils sont expliqués en français et vérifiés à la demande puis à l’exécution. Une table absente est ignorée : la détection passe par `sqlite_master`.

| Code | Situation |
| --- | --- |
| `balance` | Solde disponible positif dans le grand livre |
| `pending_balance` | Gains en attente de libération |
| `withdrawal` | Retrait en cours |
| `tester_missions` | Missions de test en cours |
| `campaign_missions` | Missions en cours sur les campagnes du membre |
| `campaign_escrow` | Séquestre restant sur une campagne |
| `orders` | Commandes de la marketplace en cours |
| `payments` | Paiements en cours de confirmation |
| `disputes` | Litiges de paiement ouverts |
| `organization_owner` | Seul propriétaire d’une organisation qui a d’autres membres |
| `last_admin` | Dernier administrateur de la plateforme |

**Exécution.** Le job `privacy.erasure` tourne toutes les heures. L’administration peut aussi exécuter une demande en avance. Tout se fait dans une seule transaction, dans cet ordre :

1. **Gestionnaires des modules** (`registerPersonalData().erase`). Ils passent *avant* l’anonymisation cœur, ce qui est volontairement différent de l’ordre du cahier des charges : les tables des modules référencent les lignes cœur (enfants avant parents). Cela évite les violations de clés étrangères et laisse chaque module décider de ce qu’il conserve.
2. **Suppressions et clôtures** :
   - sessions, abonnements (membres et projets), favoris, notifications, e-mails en file ou journalisés pour ce membre, mentions « j’aime », appartenances aux groupes, invitations reçues ;
   - candidatures en attente sans mission ; la motivation des autres candidatures est effacée ;
   - les invitations envoyées et encore en attente sont révoquées ;
   - les campagnes ouvertes sont clôturées et leurs candidats prévenus ;
   - les annonces de la marketplace sont archivées.
3. **Contenus remplacés, structure conservée** :
   - messages envoyés → `[message supprimé]`, ou le marqueur du module communication s’il est déjà posé ;
   - publications → `[publication supprimée]` ;
   - commentaires → `[commentaire supprimé]` ;
   - avis → `[avis supprimé]`.

   Les conversations des autres membres restent intactes.
4. **Projets** :
   - un projet rattaché à une organisation qui compte d’autres membres est conservé ;
   - un autre projet est supprimé, avec ses publications, ses intégrations et les favoris qui le visent ;
   - si un projet ne peut pas être supprimé parce qu’il est référencé (missions, commandes…), il est archivé en privé et vidé.
5. **Organisations** : elles sont supprimées si possible, sinon leur description est effacée.
6. **Ligne `users`** :
   - nom `Compte supprimé` ;
   - e-mail `deleted-<id>@alpha.invalid` ;
   - empreinte de mot de passe inutilisable ;
   - titre, bio, compétences et avatar effacés ;
   - rôle `member`.
7. **Conservé au titre des obligations légales** : grand livre, transactions, factures, retraits, acceptations légales et audit, rattachés à l’identifiant anonymisé.
8. Enregistrement de l’action `audit('privacy.erasure.completed')`.

**Garanties :**

- l’opération est idempotente : une seconde exécution ne modifie rien ;
- `PRAGMA foreign_key_check` reste vide ;
- une demande bloquée reste `scheduled`, avec `last_error`, et le membre est notifié une fois par motif distinct.

### Consentements (art. 7)

`GET /api/privacy/consents` et `PUT /api/privacy/consents` gèrent trois finalités :

- `marketing_email` ;
- `product_updates` ;
- `analytics`.

Chaque valeur est enregistrée avec la version de `legalDocuments.privacy.version`. Si la politique change de version, l’interface propose de confirmer les choix. Chaque changement crée une ligne immuable dans `consent_events`.

Les autres modules interrogent le consentement ainsi :

```ts
import { hasConsent } from '../privacy/consents.js';
if (hasConsent(userId, 'marketing_email')) queueEmail({ /* e-mail promotionnel */ });
```

`hasConsent` renvoie `false` dans trois cas : pas de ligne, consentement retiré, ou compte en cours de suppression. Les e-mails transactionnels (sécurité, paiements, missions) n’en dépendent pas.

### Documents légaux

| Slug | Fichier | Obligatoire |
| --- | --- | --- |
| `terms` | `docs/legal/conditions-generales.md` | oui |
| `privacy` | `docs/legal/confidentialite.md` | oui |
| `payments` | `docs/legal/paiements.md` | non (à accepter avant un paiement) |
| `tester_charter` | `docs/legal/charte-testeur.md` | non (à accepter avant de tester) |
| `seller_terms` | `docs/legal/conditions-vendeur.md` | non (à accepter avant de vendre) |
| `legal_notice` | `docs/legal/mentions-legales.md` | information uniquement, pas d’acceptation |

**Versions.** Chaque fichier commence par un en-tête `version`/`updated`. La version doit être identique à `server/platform/legal.ts` (`2026-11-v4`). Sinon l’API signale `file_version_mismatch`.

**Remplacement des variables.** Les `{{variables}}` sont remplacées par les valeurs du réglage `privacy.controller`, après échappement Markdown. Une valeur vide devient « [à compléter : …] » et apparaît dans `missing`.

**Rendu sûr.** Le rendu passe par un arbre de syntaxe et n’utilise jamais `dangerouslySetInnerHTML`. Le HTML brut reste du texte. Les liens ne sont autorisés que vers :

- `#ancre` ;
- `/chemin` ;
- `mailto:` ;
- `https://`, sans identifiants dans l’URL.

**Points d’accès :**

- `GET /api/privacy/legal` ;
- `GET /api/privacy/legal/:doc` ;
- `POST /api/privacy/legal/accept {documents}` (utilise `recordLegalAcceptance`) ;
- `GET /api/privacy/legal/acceptances`.

## Points d’accès

**Membre :**

- `GET /requests` ;
- `POST /exports` ;
- `GET /exports/:id/download` ;
- `GET /erasure`, `POST /erasure`, `DELETE /erasure` ;
- `GET /consents`, `PUT /consents` ;
- `GET /legal` et `GET /legal/:doc` : publics ;
- `GET /legal/acceptances` et `POST /legal/accept` : connexion requise.

Toutes les autres routes membre demandent une connexion (`requireUser`).

**Administration** (`requireAdmin`, chaque écriture est auditée sous `privacy.admin.*`) :

| Méthode et chemin | Usage |
| --- | --- |
| `GET /admin/overview` | Compteurs, échéances, alerte d’identité incomplète |
| `GET /admin/requests?kind=&status=open` | File des demandes |
| `POST /admin/requests/:id/process` | Traiter un export maintenant |
| `POST /admin/requests/:id/reject {reason}` | Refus motivé |
| `POST /admin/requests/:id/execute` | Exécuter une suppression maintenant. Refusé sur son propre compte. Audité avec `"early":true` si le délai de grâce n’est pas écoulé. |
| `GET /admin/retention`, `PUT /admin/retention` | Durées de conservation |
| `POST /admin/retention/run {dry_run}` | Simulation (`dry_run`, vrai par défaut) ou purge |
| `GET /admin/controller`, `PUT /admin/controller` | Identité du responsable de traitement |
| `GET /admin/register`, `GET /admin/register/download` | Registre des traitements (art. 30), JSON |
| `GET /admin/breaches`, `POST /admin/breaches` | Registre des violations : liste et création |
| `PATCH /admin/breaches/:id`, `DELETE /admin/breaches/:id` | Modification. La suppression n’est possible que dans les 24 h, pour corriger une erreur de saisie ; ensuite le registre est conservé. |

## Réglages

**`privacy.controller`** : identité du responsable de traitement, utilisée dans les documents.

- Champs : `company_name`, `legal_form`, `share_capital`, `address`, `registration`, `vat_number`, `email`, `phone`, `dpo_email`, `director`, `host_name`, `host_address`.
- `share_capital`, `vat_number` et `phone` sont facultatifs pour l’alerte de la console, mais requis par l’article 6-III de la LCEN dans les mentions légales des sociétés.

**`privacy.retention`** : durées de conservation, appliquées par le job `privacy.retention`.

| Clé | Défaut | Minimum | Données |
| --- | --- | --- | --- |
| `enabled` | `true` | — | Active le job |
| (aucune) | expiration | — | Sessions expirées |
| `notifications_read_days` | 365 | 30 | Notifications lues |
| `email_sent_days` | 90 | 7 | E-mails `sent`, `logged` et `cancelled` |
| `email_failed_days` | 180 | 7 | E-mails `failed` |
| (aucune) | expiration | — | Compteurs `rate_limit_buckets` |
| `audit_days` | 1095 (3 ans) | 365 | Audit ordinaire |
| `audit_long_days` | 3650 (10 ans) | 1095 | Audit dont l’action commence par un préfixe long |
| `audit_long_prefixes` | `payment`, `ledger`, `escrow`, `withdrawal`, `invoice`, `order`, `mission`, `campaign`, `compliance`, `kyc`, `trust`, `moderation`, `risk`, `privacy`, `admin`… | — | Actions argent, confiance et RGPD |
| `risk_signals_days` | 180 | 30 | `risk_signals` (seulement si la table existe) |
| `privacy_requests_days` | 1095 | 365 | Demandes clôturées |

Les archives d’export ne sont jamais stockées. Une demande `ready` passe à `completed` après 7 jours.

Les tables des autres modules ne sont **pas** purgées ici : chaque module les purge par son propre job (`accounts.purge`, `realtime.*`, `files.*`, etc.).

Seule exception : `risk_signals` (module trust), purgée seulement si la table existe. Le module trust lit lui-même `privacy.retention.risk_signals_days` dans sa purge `purgeTrustData()`. La purge du module privacy applique la même durée et sert de filet de sécurité ; les deux purges sont cohérentes et idempotentes.

## Jobs

| Job | Fréquence | Rôle |
| --- | --- | --- |
| `privacy.erasure` | toutes les heures | Exécute les suppressions arrivées à échéance |
| `privacy.exports` | toutes les 5 min | Traite les exports en attente et clôt les exports expirés |
| `privacy.retention` | tous les jours (si `enabled`) | Purge selon `privacy.retention` |

## Notes AIPD (art. 35)

Une analyse d’impact est recommandée, et probablement obligatoire au vu de la liste CNIL des traitements soumis à AIPD, pour :

**KYC / vérification d’identité** (module compliance) :

- données d’identité, pièces justificatives, adresse scellée ;
- base légale : obligation LCB-FT (CMF L561-5 et suivants) ;
- conservation : 5 ans après la fin de la relation ;
- risques : usurpation, fuite des pièces ;
- mesures : chiffrement des champs scellés, accès réservé aux administrateurs et audité, fichiers analysés par ClamAV, export sans contenu des pièces, effacement des champs d’identité à la suppression du compte, sauf obligation de conservation.

**Anti-fraude et score de risque** (module trust) :

- surveillance systématique (signaux, empreinte d’appareil hachée, limitation de débit) pouvant mener à des restrictions ;
- base légale : intérêt légitime ;
- mesures :
  - pas de décision entièrement automatisée produisant des effets juridiques sans intervention humaine possible (art. 22) : les sanctions sont révisables et une procédure d’appel existe ;
  - signaux conservés 180 jours ;
  - information dans la politique de confidentialité ;
  - identifiant d’appareil `localStorage` aléatoire, non traçant entre sites.

**Paiements et Mobile Money** :

- transferts hors UE (Stripe aux États-Unis ; Flutterwave, CamPay, MTN, Orange, Wave et Kratos Pay en Afrique) ;
- l’exploitant doit documenter les garanties : clauses contractuelles types, décision d’adéquation (EU-US Data Privacy Framework pour Stripe), évaluation des transferts.

## Sous-traitants et destinataires

| Sous-traitant | Rôle |
| --- | --- |
| Hébergeur | Hébergement (réglage `host_name`) |
| Fournisseur SMTP | Envoi d’e-mails |
| Stripe, Flutterwave, CamPay, MTN MoMo, Orange Money, Wave, Kratos Pay | Paiements |
| GitHub, GitLab, Figma, Google | Connexion OAuth et intégrations activées par le membre |

ClamAV tourne en local : ce n’est pas un sous-traitant. La liste publique se trouve dans `docs/legal/confidentialite.md`.

## Procédure en cas de violation de données (art. 33 et 34)

1. **Détecter et contenir.** Consigner immédiatement l’incident dans *Administration → RGPD → Violations*, même s’il est incomplet : date de détection, description, catégories de données, nombre de personnes concernées, niveau de risque, mesures.
2. **Évaluer le risque** : aucun, faible ou élevé. Sans risque, l’incident reste documenté au registre, sans notification.
3. **Notifier la CNIL** dans les **72 h** suivant la détection, via le téléservice de notification de violations (notifications.cnil.fr). L’indicateur passe à « en retard » après 72 h. Une notification tardive doit être motivée dans les mesures.
4. **Informer les personnes concernées** sans délai si le risque est élevé. La console signale `users_pending` tant que la date d’information n’est pas saisie.
5. **Clôturer** : mesures correctives et retour d’expérience. Le registre reste conservé ; la suppression n’est possible que dans les 24 h, pour corriger une erreur de saisie.

## Ce qui reste à faire par l’exploitant

- **Faire valider par un juriste** les six modèles de `docs/legal/`, puis augmenter les versions dans `server/platform/legal.ts` et dans les en-têtes des fichiers. Une nouvelle version redemande l’acceptation des documents obligatoires.
- **Compléter l’identité du responsable** (*Administration → RGPD → Responsable*). La console affiche une alerte tant qu’elle est incomplète.
- **Désigner un DPO** s’il est obligatoire (art. 37 : suivi régulier et systématique à grande échelle, ce qui est probable avec l’anti-fraude), ou au minimum un contact RGPD (`dpo_email`).
- **Signer les contrats de sous-traitance (DPA, art. 28)** avec l’hébergeur, le fournisseur SMTP, les prestataires de paiement et les fournisseurs OAuth, et documenter les transferts hors UE.
- **Réaliser les AIPD** KYC et anti-fraude, et tenir à jour le registre généré : les colonnes à compléter sont indiquées dans le JSON.
- **Formalités CNIL** : pas de déclaration préalable depuis le RGPD. Désigner le DPO auprès de la CNIL si un DPO est nommé.
- **Agréments financiers** : le séquestre et la monnaie électronique supposent un établissement agréé ou un statut d’agent (voir `paiements.md`).
- **Bandeau cookies : inutile en l’état.** Seuls sont utilisés le cookie de session `alpha_session` (strictement nécessaire, HttpOnly, 7 jours) et l’identifiant `alpha_device` en `localStorage`, dédié à la sécurité (lignes directrices CNIL, exemptions de l’article 82 de la loi Informatique et Libertés). Il deviendra obligatoire dès l’ajout d’une mesure d’audience non exemptée ou de traceurs tiers : utiliser alors `hasConsent(userId, 'analytics')` et un bandeau.

## Limites connues

- Les gestionnaires des modules s’exécutent avant l’anonymisation cœur, par sécurité vis-à-vis des clés étrangères. Une erreur dans l’un d’eux annule toute la suppression, qui est retentée à l’heure suivante.
- Aucun e-mail n’est envoyé à la fin de la suppression : l’adresse n’existe plus. La confirmation est envoyée au moment de la demande.
- Les projets référencés par des données financières sont archivés en privé plutôt que supprimés.
- La suppression ne demande pas de second facteur (MFA) : seulement le mot de passe ou une connexion récente.
- L’export est construit à la demande. Un export volumineux est donc recalculé à chaque téléchargement.
- Les notifications `privacy` tombent dans la catégorie « Compte & sécurité » du module realtime. Un membre à l’adresse vérifiée peut recevoir, en plus de l’e-mail dédié, l’e-mail générique « nouvelle notification » (demande déposée au module realtime).
