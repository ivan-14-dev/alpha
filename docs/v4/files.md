# Fichiers sécurisés & antivirus (V4)

Tous les fichiers échangés sur Alpha passent par ce module : builds de campagne, pièces jointes de mission, livraisons de la marketplace, pièces
jointes de messagerie, pièces KYC, ainsi que les fichiers produits par le serveur (exports RGPD, artefacts du bac à sable).

Ce que garantit le module :
- le contenu est **chiffré au repos** ;
- chaque fichier est **analysé par ClamAV** ;
- le contenu n’est **jamais servi de façon exécutable** dans le navigateur ;
- chaque téléchargement est **autorisé selon la ressource** à laquelle le fichier est rattaché.

## Fichiers du module

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/006-files.sql` (colonnes d’analyse, de chiffrement et de conservation sur `files`, table `file_access_log`) |
| API | `server/modules/files.ts` (`/api/files/*`, administration `/api/files/admin/*`) |
| Contrat pour les autres modules | `server/files/service.ts` (`getFile`, `filesFor`, `canReadFile`, `readFileBuffer`, `storeBuffer`, `attachFile`, …) |
| Règles par usage, formats, signatures binaires | `server/files/policy.ts` |
| Chiffrement AES-256-GCM segmenté | `server/files/crypto.ts` |
| Stockage privé sur disque | `server/files/storage.ts` |
| Envoi multipart en flux (busboy) | `server/files/upload.ts` |
| Client clamd (`INSTREAM`) | `server/files/clamav.ts` |
| Analyse, quarantaine, nouvelles tentatives | `server/files/scan.ts` |
| Autorisations par ressource | `server/files/authz.ts` |
| Tâches planifiées, conservation, RGPD | `server/files/lifecycle.ts` |
| Interface | `src/components/FileUpload.tsx`, `src/components/FileAttachments.tsx`, `src/admin/FilesAdmin.tsx`, `src/styles/files.css` |
| Tests | `tests/files-v4.test.ts` |

## Modèle de menace

Actifs protégés :
- les pièces d’identité (KYC) ;
- les builds et livrables payants ;
- les rapports de test ;
- les postes des testeurs et des acheteurs qui ouvrent les fichiers ;
- l’intégrité de la plateforme (pas de XSS par fichier, pas d’écriture arbitraire sur le serveur).

| Menace | Contre-mesures |
| --- | --- |
| Logiciel malveillant diffusé à des testeurs ou acheteurs (build piégé, livraison infectée) | Analyse ClamAV de chaque fichier. Les usages partagés ne sont téléchargeables qu’une fois déclarés **sains** (`files.require_scan`, actif par défaut en production). Un fichier infecté passe en quarantaine : son contenu est effacé et le titulaire ainsi que les administrateurs sont prévenus. ClamAV ne détecte pas tout : les testeurs gardent la consigne d’exécuter les builds dans une machine virtuelle ou dans le bac à sable. |
| XSS ou hameçonnage par un fichier servi depuis le domaine d’Alpha (HTML, SVG, PDF actif, « polyglottes ») | Téléchargement forcé : `Content-Disposition: attachment`, `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `X-Download-Options: noopen`, `Cross-Origin-Resource-Policy: same-origin`. Seuls PNG, JPEG, WebP et GIF peuvent être affichés (`?inline=1`), avec leur vrai type MIME. HTML, SVG et JavaScript sont refusés dans les fichiers texte, et une image contenant du balisage est refusée. |
| Contournement par fausse extension (`.exe` renommé `.pdf`) | L’extension doit appartenir à l’usage **et** les octets magiques doivent correspondre au format annoncé. Exemples : `%PDF-`, en-tête PNG, `PK\x03\x04` pour ZIP/APK/JAR/IPA, `MZ` pour EXE, en-tête ELF pour AppImage, `!<arch>` pour `.deb`. Le type MIME stocké est celui du format reconnu, jamais celui envoyé par le navigateur. |
| Traversée de chemin, noms piégés | Les fichiers sont stockés sous une clé aléatoire (`objects/ab/<40 hex>`) : le nom fourni par l’utilisateur n’est jamais utilisé comme chemin. Le nom d’origine est assaini : chemins et caractères de contrôle ou de direction (bidi) retirés, normalisation NFC, noms réservés Windows neutralisés, 180 caractères au maximum. |
| Lecture non autorisée (IDOR) | Identifiants UUID. Un fichier non lisible renvoie 404 (son existence n’est pas révélée). Chaque usage a sa propre règle de lecture (voir « Autorisations »). |
| Accès abusif des administrateurs aux pièces d’identité | Chaque accès d’un administrateur à une pièce KYC d’un autre utilisateur est journalisé dans `file_access_log` (acteur, fichier, date, action, motif). Cela couvre l’affichage dans une liste, les métadonnées, le téléchargement et la lecture interne. Dans la liste d’administration, les noms de fichiers KYC sont masqués. |
| Vol du disque ou d’une sauvegarde du dossier de fichiers | Chiffrement AES-256-GCM authentifié, avec une clé dérivée par fichier de la clé maîtresse `ALPHA_SECRETS_KEY`, qui n’est jamais stockée avec les fichiers. |
| Altération ou échange de fichiers sur le disque | Le tag GCM est vérifié pour chaque segment, l’identifiant du fichier est inclus dans les données authentifiées (AAD), et une empreinte SHA-256 du clair est vérifiée à la lecture. Un segment altéré interrompt le téléchargement : aucun octet non authentifié n’est servi. |
| Saturation (disque, mémoire, CPU) | Envoi en flux (jamais chargé entièrement en mémoire), taille plafonnée par usage et quota par utilisateur. Le corps de la requête est coupé dès que la limite est dépassée (413). Limites de débit : 60 envois par heure et par utilisateur, 600 téléchargements par 10 minutes. busboy est limité à un fichier, 8 champs et 10 parties. |
| Bombes de décompression | Les archives ne sont jamais décompressées par l’application. ClamAV applique ses propres limites (`MaxScanSize`, `MaxRecursion`). |
| Fichiers temporaires abandonnés, objets orphelins | Les fichiers temporaires sont supprimés dès qu’un envoi échoue. La tâche `files.cleanup` nettoie aussi les temporaires de plus d’une heure et les objets sans ligne en base de plus de 6 heures. |

## Usages et limites par défaut

| Usage (`purpose`) | Ressource | Formats | Taille max | Qui peut envoyer |
| --- | --- | --- | --- | --- |
| `kyc_document` | `kyc` / `<id utilisateur>` | PDF, PNG, JPEG, WebP | 10 Mo | l’utilisateur lui-même |
| `mission_attachment` | `mission` | images (PNG, JPEG, WebP, GIF), MP4, WebM, PDF, TXT/LOG, JSON, ZIP | 50 Mo | testeur de la mission, porteur de la campagne |
| `campaign_build` | `campaign` | ZIP, tar.gz/tgz, APK, AAB, IPA, EXE, MSI, DMG, AppImage, JAR, DEB, RPM | 200 Mo | porteur de la campagne |
| `listing_delivery` | `order` | ZIP, PDF, images, TXT, Markdown | 100 Mo | vendeur, sur une commande **payée** |
| `message_attachment` | `conversation` | images, PDF, TXT, ZIP | 15 Mo | participant de la conversation |
| `privacy_export` | — | ZIP, JSON, tar.gz | 512 Mo | serveur uniquement (`storeBuffer`) |
| `sandbox_artifact` | `sandbox_run` | journaux, archives, captures | 512 Mo | serveur uniquement (`storeBuffer`) |

Les tailles et les formats de chaque usage peuvent être modifiés dans **Administration › Fichiers & antivirus › Règles & quotas**. Ils sont
enregistrés dans le réglage `files.policies` et ne peuvent pas dépasser le plafond absolu de 2 Go. Le quota par utilisateur est de 2 Go par
défaut (réglage `files.quota`). Il compte les fichiers actifs, mais pas les exports RGPD ni les artefacts du bac à sable.

## Envoi (`POST /api/files`)

1. Requête `multipart/form-data` avec les champs `purpose`, puis éventuellement `resource_type` et `resource_id`, puis **un seul** champ `file`.
   Les champs doivent précéder le fichier : ainsi, l’autorisation, le format et le quota sont vérifiés **avant** de recevoir le contenu.
2. Le contenu est inspecté (taille, SHA-256, premiers et derniers octets) puis chiffré **en flux** vers un fichier temporaire en 0600. Le
   serveur ne garde jamais le fichier entier en mémoire.
3. Les octets magiques sont vérifiés et le contenu actif (HTML, SVG, JavaScript) est refusé. Le fichier temporaire est ensuite déplacé
   atomiquement dans `objects/`.
4. Une transaction revérifie l’autorisation et le quota, puis insère la ligne. Le statut d’analyse vaut `pending` si un antivirus est
   configuré ou exigé, `skipped` sinon.
5. L’analyse antivirus est lancée **après** la réponse 201, hors transaction.

Codes d’erreur :

| Code | Cas |
| --- | --- |
| 400 | formulaire invalide |
| 403 | ressource non autorisée |
| 404 | ressource inexistante |
| 409 | état de la ressource incompatible (commande non payée, mission annulée, …) |
| 413 | taille par usage ou quota dépassé |
| 415 | format ou contenu refusé |
| 429 | limite de débit atteinte |

Un fichier envoyé sans ressource reste « non rattaché ». Il peut être rattaché plus tard avec `POST /api/files/:id/attach` ou, côté serveur,
avec `attachFile()` dans la transaction de l’appelant (par exemple la soumission d’un dossier KYC). Sinon, il est supprimé au bout de 24 h.
Les brouillons KYC sont gardés 30 jours.

## Stockage et chiffrement

- **Dossier** : `FILES_DIR`, par défaut `<dossier de DATABASE_PATH>/files`. Pour une base `:memory:` (tests), le module utilise un dossier
  temporaire propre au processus. Les dossiers sont en 0700 et les fichiers en 0600. Arborescence :
  - `objects/<2 hex>/<40 hex>` : un objet par fichier ;
  - `tmp/` : fichiers en cours d’envoi.
- **Format** : en-tête de 32 octets (magic `ALF\x01`, empreinte de la clé, préfixe de nonce aléatoire, taille de segment), suivi de segments de
  64 Kio. Chaque segment est chiffré en AES-256-GCM avec son propre tag (construction « STREAM »). Le nonce encode le numéro du segment et un
  drapeau « dernier segment », ce qui détecte la troncature et le réordonnancement. Les données authentifiées (AAD) incluent l’identifiant du
  fichier, ce qui empêche d’échanger deux objets sur le disque.
- **Clé par fichier** : `HMAC-SHA256(ALPHA_SECRETS_KEY, "file-encryption\0<id du fichier>")` (`keyedHash` de la plateforme). Aucune clé de
  fichier n’est stockée en base. On ne conserve que l’empreinte de la clé maîtresse utilisée (`files.key_fingerprint`).
- **Intégrité** : le SHA-256 du clair est stocké (`files.sha256`, exposé dans l’en-tête `X-File-Sha256`). `readFileBuffer()` le vérifie après
  déchiffrement.

### Rotation des clés : implications

- **Perdre `ALPHA_SECRETS_KEY` rend tous les fichiers illisibles.** Sauvegardez la clé **séparément** du dossier de fichiers et de la base. Si
  la clé et les données sont sauvegardées ensemble, le chiffrement au repos ne protège plus rien.
- Pour faire tourner la clé :
  1. Placez l’ancienne clé dans `ALPHA_SECRETS_KEY_PREVIOUS` (liste séparée par des virgules) et la nouvelle dans `ALPHA_SECRETS_KEY`.
  2. Les fichiers existants restent lisibles grâce à l’empreinte stockée dans l’en-tête.
  3. La tâche `files.rekey` (toutes les 6 h, active seulement si `ALPHA_SECRETS_KEY_PREVIOUS` est défini) rechiffre progressivement chaque
     fichier avec la nouvelle clé. Elle écrit un nouvel objet, vérifie le SHA-256, bascule la ligne, puis supprime l’ancien objet.
  4. Vous pouvez aussi la déclencher depuis l’administration (« Rechiffrer avec la clé actuelle »). Le compteur « Fichiers sur une ancienne
     clé » doit retomber à 0.
- Une fois ce compteur à 0, l’ancienne clé n’est plus nécessaire **pour les fichiers**. Elle peut l’être encore pour d’autres secrets scellés
  par la plateforme (voir `docs/operations.md`).
- Une clé compromise impose cette rotation. Les objets déjà copiés par un attaquant avec l’ancienne clé restent déchiffrables par lui : la
  rotation protège l’avenir, pas le passé.

## Antivirus (ClamAV)

### Fonctionnement

- Le module parle le protocole clamd `INSTREAM` en TCP :
  1. il envoie `zINSTREAM\0` ;
  2. il transmet des segments, chacun précédé de sa taille sur 4 octets big-endian ;
  3. il termine par un segment de taille nulle ;
  4. il lit la réponse `stream: OK` ou `stream: <signature> FOUND`.
- Le contenu est déchiffré en flux vers clamd : il n’est jamais écrit en clair sur le disque.
- La configuration vient du réglage `files.clamav` `{enabled, host, port, timeout_ms}` (**Administration › Fichiers & antivirus ›
  Antivirus**). Tant que ce réglage n’a pas été enregistré, ce sont les variables `CLAMAV_HOST`, `CLAMAV_PORT` (3310) et
  `CLAMAV_TIMEOUT_MS` (60 000) qui s’appliquent. Le bouton « Revenir aux variables d’environnement » efface le réglage.

Statuts d’analyse :

| Statut | Signification | Téléchargement des usages partagés |
| --- | --- | --- |
| `pending` « Analyse en cours » | en attente ou antivirus injoignable (nouvel essai avec délai croissant : 1 min, 2 min, … jusqu’à 1 h) | refusé (409) |
| `clean` « Sain » | `stream: OK` | autorisé |
| `infected` « Infecté — mis en quarantaine » | signature trouvée, ou quarantaine manuelle par un administrateur | refusé (410) : contenu effacé |
| `error` « Erreur d’analyse » | réponse d’erreur de clamd (ex. `INSTREAM size limit exceeded`) ; pas de nouvel essai automatique, l’administrateur peut relancer l’analyse | refusé (409) |
| `skipped` « Non analysé » | aucun antivirus configuré et analyse non exigée | autorisé seulement si `files.require_scan` vaut `false` |

- **Usages concernés par le contrôle** : `campaign_build`, `listing_delivery`, `message_attachment`, `mission_attachment` et `kyc_document`.
  Les contenus produits par le serveur (`privacy_export`, `sandbox_artifact`) ne sont jamais bloqués par l’analyse. Les exports RGPD ne sont
  jamais analysés. Les artefacts du bac à sable enregistrés avec `skipScan` sont marqués `skipped`, puis analysés par `files.scan` dès qu’un
  antivirus est configuré : un artefact infecté est mis en quarantaine.
- **Analyse exigée** : `files.require_scan` vaut `true` par défaut en production et `false` ailleurs. Si l’analyse est exigée sans antivirus
  configuré, les nouveaux fichiers restent `pending` : rien n’est partagé sans analyse.
- **Analyse non exigée** : si l’analyse n’est pas exigée et qu’aucun antivirus n’est configuré, la tâche `files.scan` passe les fichiers
  `pending` en `skipped`. Inversement, dès qu’un antivirus est configuré, elle analyse aussi les fichiers `skipped`.
- **Quarantaine** : le contenu chiffré est effacé immédiatement, les métadonnées (nom, SHA-256, signature) sont conservées, et une
  notification est envoyée au titulaire (`files.quarantined`) et aux administrateurs (`files.quarantined_admin`, lien `/admin/files`).
- **Test** : le bouton « Tester avec EICAR » envoie la chaîne de test EICAR (inoffensive) au clamd configuré, ou aux paramètres saisis dans le
  formulaire. Un antivirus opérationnel répond `Eicar-Test-Signature FOUND`.

### Déploiement

Le fichier `deploy/compose.yaml` contient un service `clamav` (image officielle `clamav/clamav:stable`). L’application le joint par
`CLAMAV_HOST=clamav` et `CLAMAV_PORT=3310`, sur le réseau interne uniquement : **n’exposez jamais le port 3310**.

- **Mémoire** : prévoyez environ 1,5 Go pour clamd, et jusqu’à 3 Go pendant le rechargement des signatures.
- **Signatures** : `freshclam` tourne dans le conteneur et met à jour les signatures plusieurs fois par jour. Le premier démarrage télécharge
  environ 300 Mo, ce qui prend quelques minutes. Persistez `/var/lib/clamav` dans un volume pour ne pas tout retélécharger à chaque
  redémarrage.
- **Limites de taille** : par défaut, `StreamMaxLength` vaut 100 Mo, ce qui est inférieur à la limite des builds (200 Mo). Montez un
  `clamd.conf` adapté, par exemple :

  ```
  StreamMaxLength 260M
  MaxScanSize 1024M
  MaxFileSize 260M
  MaxRecursion 16
  ```

  Avec la configuration par défaut, les builds de plus de 100 Mo finissent en « Erreur d’analyse ». Augmentez aussi le délai (`timeout_ms` ou
  `CLAMAV_TIMEOUT_MS`) à au moins 120 000 ms pour les gros fichiers.
- **Supervision** : `docker compose logs clamav`, le test EICAR de la console, et les compteurs « En attente » et « Erreurs d’analyse » de la
  vue d’ensemble. Une file `pending` qui grossit signale un clamd arrêté.

## Autorisations

| Usage | Lecture | Envoi / rattachement | Suppression par le titulaire |
| --- | --- | --- | --- |
| tous | titulaire (sauf contenu en quarantaine) et administrateurs | — | oui, sauf exceptions ci-dessous |
| `kyc_document` | titulaire, administrateurs (accès **journalisé**) | titulaire, pour lui-même | non une fois le dossier soumis (conservation légale) |
| `campaign_build` | porteur de la campagne, testeurs ayant une candidature acceptée ou une mission (non annulée) sur la campagne | porteur | oui |
| `mission_attachment` | testeur de la mission, porteur de la campagne | testeur, porteur (mission non annulée) | non si la mission est validée, payée ou en litige |
| `listing_delivery` | vendeur, acheteur (commande payée, livrée, terminée ou en litige ; jamais annulée ou remboursée) | vendeur, commande au statut `paid` | non une fois livrée |
| `message_attachment` | participants de la conversation | participant | oui |
| `sandbox_artifact` | demandeur de l’exécution, porteur de la campagne (table `sandbox_runs` lue seulement si elle existe) | serveur | — |
| `privacy_export` | titulaire uniquement (pas les administrateurs) | serveur | — |

- Un fichier ne peut être rattaché qu’à **une seule** ressource, et uniquement par son titulaire. Rattacher de nouveau à la même ressource
  est sans effet.
- La suppression est d’abord logique (`deleted_at`). Le contenu chiffré est ensuite effacé physiquement (`purged_at`), immédiatement ou par
  `files.cleanup`. Les métadonnées supprimées sont conservées pour la traçabilité et pour les clés étrangères.

## Téléchargement

`GET /api/files/:id/download` déchiffre le fichier en flux et renvoie les en-têtes suivants :
- `Content-Disposition: attachment; filename="<repli ASCII>"; filename*=UTF-8''<nom encodé RFC 5987>` ;
- `Content-Type: application/octet-stream`, sauf avec `?inline=1` pour les images PNG, JPEG, WebP et GIF, qui sont alors servies avec leur
  vrai type en `inline` ;
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`,
  `Cross-Origin-Resource-Policy: same-origin`, `X-Download-Options: noopen`, `Content-Length` et `X-File-Sha256`.

Pour un administrateur qui consulte une pièce KYC, le paramètre `?reason=` alimente le journal d’accès.

## API

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/api/files/policies` | règles d’envoi (formats, tailles), quota utilisé, analyse exigée |
| POST | `/api/files` | envoi multipart (`purpose`, `resource_type`, `resource_id`, `file`) |
| GET | `/api/files` | mes fichiers ; avec `?resource_type=&resource_id=`, les fichiers lisibles de la ressource |
| GET | `/api/files/:id` | métadonnées |
| GET | `/api/files/:id/download` | contenu (`?inline=1` pour les images) |
| POST | `/api/files/:id/attach` | `{resource_type, resource_id}` |
| DELETE | `/api/files/:id` | suppression (titulaire ou administrateur) |
| GET | `/api/files/admin/overview` | statistiques par usage et par statut, antivirus, chiffrement, règles |
| GET | `/api/files/admin/files` | liste filtrée (`scan_status`, `purpose`, `state`, `q`, `limit`, `offset`) |
| POST | `/api/files/admin/files/:id/rescan` | nouvelle analyse forcée |
| POST | `/api/files/admin/files/:id/quarantine` | `{reason}` : quarantaine manuelle |
| DELETE | `/api/files/admin/files/:id` | `{reason?}` : suppression par un administrateur |
| PUT | `/api/files/admin/settings` | `clamav`, `require_scan`, `quota_bytes`, `policies`, `kyc_retention_days` |
| POST | `/api/files/admin/clamav/test` | ping, version et test EICAR (paramètres optionnels `{host, port, timeout_ms}`) |
| GET | `/api/files/admin/access-log` | journal d’accès KYC (`file_id`, `actor_id`, `limit`) |
| POST | `/api/files/admin/scan-pending` · `/cleanup` · `/rekey` | lancement manuel des tâches |

Toutes les actions d’administration sont inscrites au journal d’audit (`files.rescan`, `files.quarantine`, `files.delete`, `files.settings`,
`files.clamav_test`, …).

## Réglages et variables d’environnement

| Nom | Défaut | Rôle |
| --- | --- | --- |
| `FILES_DIR` | `<dossier de DATABASE_PATH>/files` | dossier de stockage chiffré |
| `CLAMAV_HOST` / `CLAMAV_PORT` / `CLAMAV_TIMEOUT_MS` | — / 3310 / 60000 | clamd, si le réglage `files.clamav` n’est pas enregistré |
| `ALPHA_SECRETS_KEY` / `ALPHA_SECRETS_KEY_PREVIOUS` | — | clé maîtresse ; anciennes clés pour la rotation |
| `files.clamav` | (variables d’environnement) | `{enabled, host, port, timeout_ms}` |
| `files.require_scan` | `true` en production | exige une analyse « saine » avant tout téléchargement partagé |
| `files.policies` | (tableau ci-dessus) | surcharges `{<usage>: {max_bytes?, kinds?}}` |
| `files.quota` | `{bytes_per_user: 2 Gio}` | quota par utilisateur |
| `files.kyc_retention_days` | 1825 (5 ans) | conservation des pièces KYC après la clôture du compte |

## Tâches planifiées

| Tâche | Fréquence | Rôle |
| --- | --- | --- |
| `files.scan` | 1 min | relance les analyses `pending` dont le délai est écoulé (50 par passage) ; analyse les `skipped` si un antivirus est apparu ; passe les `pending` en `skipped` si l’analyse n’est plus ni configurée ni exigée |
| `files.cleanup` | 1 h | supprime les fichiers non rattachés de plus de 24 h (brouillons KYC : 30 jours), les exports RGPD de plus de 7 jours et les pièces KYC dont la conservation légale est échue ; efface physiquement les contenus supprimés ou en quarantaine (500 par passage), les temporaires de plus d’une heure et les objets orphelins |
| `files.rekey` | 6 h | rechiffre avec la clé courante (actif seulement si `ALPHA_SECRETS_KEY_PREVIOUS` est défini) |

## Conservation et RGPD

Le module s’enregistre auprès du module RGPD (`registerPersonalData('files')`).

- **Export** : métadonnées des fichiers de l’utilisateur (nom, usage, taille, SHA-256, statut, dates, ressource) et accès des administrateurs
  à ses pièces KYC. Le contenu lui-même reste téléchargeable par l’utilisateur.
- **Effacement** :
  - **pièces KYC** : conservées jusqu’à la fin de la durée légale (`retain_until` = date d’effacement + `files.kyc_retention_days`, 5 ans par
    défaut, obligations LCB-FT), puis supprimées par `files.cleanup`. Elles restent consultables uniquement par les administrateurs, avec
    journalisation ;
  - **livraisons déjà remises à un acheteur** (commande livrée, terminée ou en litige) : conservées pour l’acheteur, mais **dissociées** du
    vendeur (`owner_id = NULL`) ;
  - **tous les autres fichiers** : supprimés, nom remplacé par `fichier-supprime.<ext>`, contenu effacé physiquement.
- **Autres durées** : uploads non rattachés 24 h, brouillons KYC 30 jours, exports RGPD 7 jours. Les métadonnées des fichiers supprimés et
  le journal d’accès KYC sont conservés à des fins de preuve.

## Interface

- `FileUpload` (`purpose`, `resourceType?`, `resourceId?`, `label?`, `accept?`, `disabled?`, `onUploaded`) :
  - fonctionne par glisser-déposer ou par sélecteur de fichier ;
  - affiche la progression (événements `upload` de `XMLHttpRequest`, en-têtes `X-Alpha-Client: web` et `X-Alpha-Device`) et propose un
    bouton d’annulation ;
  - pré-vérifie le format, la taille et le quota, et affiche les formats et limites acceptés ;
  - annonce les erreurs via `role="alert"`.

  Le composant ne rend pas d’élément `<form>` : il peut être intégré dans un formulaire existant.
- `FileAttachments` (`resourceType`, `resourceId`, `purpose`, `canUpload?`, `title?`) :
  - affiche la liste des fichiers de la ressource avec un badge d’analyse (« Analyse en cours », « Sain », « Infecté — mis en quarantaine »,
    « Erreur d’analyse », « Non analysé ») ;
  - propose le téléchargement, l’aperçu des images et la suppression (titulaire), ainsi qu’un `FileUpload` si `canUpload` ;
  - interroge le serveur toutes les 5 s tant qu’une analyse est en cours et annonce la fin de l’analyse (`aria-live`).
- `FilesAdmin` (**Administration › Fichiers & antivirus**), en cinq onglets :
  - **Vue d’ensemble** : statistiques par usage, chiffrement, maintenance ;
  - **Fichiers** : filtres, nouvelle analyse, quarantaine, suppression, téléchargement avec motif pour les pièces KYC ;
  - **Antivirus** : connexion clamd, test EICAR, analyse obligatoire ;
  - **Règles & quotas** ;
  - **Journal KYC**.

## Tests

```
npx tsx --test tests/files-v4.test.ts
```

Couverture :
- envoi nominal et chiffrement au repos (octets sur disque différents, aller-retour) ;
- octets magiques, contenu actif et règles multipart ;
- limites 413 et surcharges par réglage, quota ;
- assainissement des noms ;
- EICAR via un faux clamd TCP (quarantaine et notifications) ;
- antivirus indisponible → `pending` → nouvel essai par la tâche → `clean` ;
- matrice d’autorisations (titulaire, autre utilisateur, administrateur, testeur, acheteur, commande remboursée, artefact du bac à sable,
  export RGPD) ;
- en-têtes de téléchargement ;
- règles de rattachement ;
- journal d’accès KYC ;
- suppression ;
- `files.require_scan` ;
- tâche `files.cleanup` ;
- RGPD.

## Limites connues

- ClamAV ne détecte que des menaces connues : un build malveillant inédit passera l’analyse. Exécutez les builds dans le bac à sable ou dans
  une machine virtuelle.
- Les archives chiffrées par mot de passe ne peuvent pas être analysées : ClamAV les déclare généralement saines.
- Les très gros envois (200 Mo et plus sur une connexion lente) peuvent dépasser le délai par défaut de Node (`requestTimeout`, 5 min). Le
  serveur HTTP (`server/index.ts`) doit l’augmenter si nécessaire.
- Pas de reprise d’envoi interrompu (pas de tus ni de multipart par morceaux) : il faut renvoyer le fichier entier.
- Le stockage est local, sur un seul nœud. Pour plusieurs instances, partagez `FILES_DIR` (volume réseau) ou ajoutez un pilote S3 derrière
  `server/files/storage.ts`.
- Les métadonnées des fichiers supprimés ne sont jamais effacées de la table `files` (traçabilité et clés étrangères). Seul le contenu l’est.
