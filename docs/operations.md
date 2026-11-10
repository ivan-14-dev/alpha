# Exploiter Alpha — runbooks

Procédures pour l’instance déployée selon [deployment.md](deployment.md). Toutes les commandes se lancent depuis
`/opt/alpha/deploy` (`docker compose …`). L’état courant se lit dans **Console admin › Vue d’ensemble** et
**Console admin › Système** (environnement, sauvegardes, tâches, historique des réglages).

## Repères

| Besoin | Commande |
| --- | --- |
| État des services | `docker compose ps` |
| Journaux applicatifs (JSON) | `docker compose logs -f --since 15m app` |
| Suivre une requête | `docker compose logs app \| grep '<X-Request-Id>'` |
| Prêt ? | `curl -fsS https://<domaine>/api/system/ready` |
| Sauvegarde immédiate | `docker compose exec app npm run backup` |
| Lister les sauvegardes | `docker compose exec app npm run backup -- --list` |
| Promouvoir un administrateur | `docker compose exec app npm run admin:promote -- <email>` |
| Redémarrer l’application | `docker compose restart app` |

`/api/system/ready` renvoie `{"status":"ready","checks":{"database":"ok","migrations":"ok","secrets":"ok"}}` ou
**503** avec le contrôle en échec. Les tâches planifiées (`mail.deliver`, `files.scan`, `ops.backup`…) tournent
dans le processus de l’application ; **Console admin › Système › Tâches** affiche leur dernier état et permet de
les relancer (action auditée). **Une seule instance doit exécuter les tâches** : démarrez les éventuelles instances
supplémentaires avec `ALPHA_JOBS=off` (les exécutions du bac à sable appartiennent au processus qui les a réservées,
une deuxième instance les marquerait en erreur au démarrage).

## Alertes Prometheus

Fichiers fournis : [`deploy/prometheus/prometheus.example.yml`](../deploy/prometheus/prometheus.example.yml)
(collecte) et [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) (règles, vérifiées avec
`promtool check rules`). La collecte se fait sur `http://app:3001/api/system/metrics` avec
`Authorization: Bearer <METRICS_TOKEN>` (Prometheus attaché au réseau `alpha_default`, ou depuis une adresse
privée via Caddy, qui renvoie 404 aux adresses publiques).

| Alerte | Condition | Runbook |
| --- | --- | --- |
| `AlphaDown` | cible injoignable 2 min | [Application indisponible](#application-indisponible) |
| `AlphaSchemaBehind` | `alpha_schema_version < alpha_schema_latest_version` | [Application indisponible](#application-indisponible) |
| `AlphaHigh5xxRate` | > 5 % de 5xx sur 10 min | [Erreurs 5xx](#erreurs-5xx) |
| `AlphaSlowRequests` | p95 > 2 s (flux temps réel exclus) | [Lenteurs](#lenteurs) |
| `AlphaJobFailing` | `alpha_job_last_run_failed == 1` depuis 30 min | [Tâche planifiée en échec](#tâche-planifiée-en-échec) |
| `AlphaBackupStale` | dernière sauvegarde complète > 26 h | [Sauvegarde manquante](#sauvegarde-manquante) |
| `AlphaEmailOutboxStuck` / `AlphaEmailFailures` | file bloquée > 30 min / > 5 échecs en 1 h | [E-mails non envoyés](#e-mails-non-envoyés) |
| `AlphaRestarting`, `AlphaMemoryHigh` | > 3 redémarrages/h, RSS > 1,5 Go | [Application indisponible](#application-indisponible), [Lenteurs](#lenteurs) |
| `AlphaDatabaseGrowing`, `AlphaDiskAlmostFull` | WAL > 512 Mo, < 15 % libre (node_exporter) | [Disque plein](#disque-plein) |

Complétez avec une sonde externe (blackbox, Uptime Kuma…) sur `/api/system/ready` et sur l’expiration du
certificat TLS. Principales séries exposées :

- `alpha_http_requests_total{method,route,status}` et `alpha_http_request_duration_seconds` (histogramme
  `{method,route}`) — `route` est le motif Express (`/api/projects/:id`), jamais une URL ni un identifiant ;
- `alpha_job_runs_total`, `alpha_job_failures_total`, `alpha_job_last_run_failed`, `alpha_job_running`,
  `alpha_job_last_finished_timestamp_seconds` (`{job}`) ;
- `alpha_email_outbox{status}`, `alpha_email_outbox_oldest_queued_age_seconds` ;
- `alpha_payment_intents{status,mode}` (si le module paiements est installé), `alpha_payment_mode{mode}` ;
- `alpha_db_size_bytes`, `alpha_db_wal_size_bytes`, `alpha_db_freelist_bytes`, `alpha_schema_version` ;
- `alpha_backup_last_success_timestamp_seconds`, `alpha_backup_last_size_bytes`, `alpha_backups` ;
- `alpha_users`, `alpha_active_sessions`, `alpha_build_info{version,node}`, `process_*`, `nodejs_*`.

## Incidents

### Application indisponible

1. `docker compose ps` : `app` est-il `unhealthy`, `restarting`, arrêté ?
2. `docker compose logs --tail 200 app` : une erreur au démarrage est explicite. Causes fréquentes :
   - `ALPHA_SECRETS_KEY est requis en production` / `doit contenir 32 octets` → corriger `deploy/.env`
     puis `docker compose up -d app` ;
   - `APP_ORIGIN` manquant → idem ;
   - échec de migration → **ne pas** relancer en boucle : faire une copie du volume (ci-dessous), noter l’erreur
     et revenir à la version précédente ([deployment.md › Revenir en arrière](deployment.md#revenir-en-arrière)) ;
   - `SQLITE_FULL` / `ENOSPC` → [Disque plein](#disque-plein) ;
   - `database is locked` persistant → un autre processus tient la base (une restauration lancée à côté ?) :
     `docker compose ps -a`, `docker ps` puis arrêter le conteneur en trop.
3. `/api/system/ready` en 503 mais le processus tourne : le corps indique le contrôle fautif (`database`,
   `migrations` ou `secrets`).
4. Si Caddy répond 502 alors que `app` est sain : `docker compose logs caddy`, puis `docker compose restart caddy`.

Copie de sécurité « à froid » du volume avant toute manipulation risquée :

```bash
docker compose stop app
docker run --rm -v alpha_alpha-data:/data:ro -v "$PWD":/out alpine tar czf /out/alpha-data-$(date +%F-%H%M).tgz -C /data .
docker compose start app
```

### Erreurs 5xx

1. Repérer les routes concernées : `sum by (route, status) (rate(alpha_http_requests_total{status=~"5.."}[5m]))`.
2. `docker compose logs --since 30m app | grep -E 'http.unhandled_error|"status":5'` : chaque erreur non gérée
   est journalisée (`http.unhandled_error`) avec `request_id`, méthode, chemin et message (sans pile d’appel en
   production) ; l’utilisateur voit le même identifiant (`X-Request-Id`).
3. Erreurs concentrées sur `/api/payments/webhooks/:provider` → vérifier le secret de webhook du prestataire
   (Console admin › Paiements) ; les prestataires réessaient, rien n’est perdu tant que l’erreur est corrigée
   dans leur fenêtre de réessai.
4. Régression après une mise à jour → revenir à la version précédente.

### Lenteurs

- p95 par route : `histogram_quantile(0.95, sum by (le, route) (rate(alpha_http_request_duration_seconds_bucket[10m])))`.
- Les requêtes de plus de 5 s sont journalisées (`http.slow_request`).
- SQLite écrit sur un seul fil : une tâche lourde (export RGPD, sauvegarde de gros fichiers) peut ralentir les
  écritures quelques secondes. Vérifiez `alpha_job_running`.
- Mémoire en hausse continue (`process_resident_memory_bytes`) → `docker compose restart app` puis ouvrir un
  ticket avec la courbe et les journaux.

### Tâche planifiée en échec

1. **Console admin › Système › Tâches** : dernier message d’erreur et dernière exécution.
2. `docker compose logs app | grep '"job":"<nom>"'`.
3. Corriger la cause (SMTP, ClamAV, prestataire…), puis **Exécuter** depuis la console pour valider.
4. Le verrou d’exécution est en mémoire : une tâche interrompue par un redémarrage peut rester affichée « en
   cours » jusqu’à sa prochaine exécution, sans bloquer quoi que ce soit. Une tâche réellement bloquée
   (`alpha_job_running` à 1 pendant des heures) se débloque en redémarrant l’application.

### Sauvegarde manquante

1. **Console admin › Système › Sauvegardes** : réglage activé ? date et taille de la dernière ?
2. Lancer **Sauvegarder maintenant** (ou `docker compose exec app npm run backup`) et lire l’erreur.
3. Causes : disque plein, `BACKUP_DIR` non inscriptible, base corrompue (`integrity_check` échoue — passer
   immédiatement à l’[exercice de restauration](#exercice-de-restauration) sur la dernière sauvegarde saine).
4. Vérifier aussi que la copie hors site (restic/rclone) a tourné : `restic snapshots --tag alpha --latest 3`.

### E-mails non envoyés

1. **Console admin › E-mails & notifications** : file d’attente, échecs et dernier message d’erreur SMTP.
2. Tester le transport depuis la console ; vérifier `SMTP_URL`, identifiants, port sortant 465/587 autorisé par
   l’hébergeur (souvent bloqué par défaut sur les VPS).
3. Après correction, les messages `queued` partent au prochain passage de `mail.deliver` (exécutable depuis
   **Système › Tâches**).

### Disque plein

1. `df -h /var/lib/docker` et `docker system df`.
2. Libérer sans risque : `docker image prune -a` (garde les images utilisées), journaux Docker (rotation déjà
   limitée à 100 Mo par service), anciennes sauvegardes (réduire la rétention dans la console puis lancer une
   sauvegarde : la rotation s’applique), archives `*.pre-restore-*` d’anciennes restaurations dans le volume.
3. Gros fichier WAL (`alpha_db_wal_size_bytes`) : un redémarrage de l’application force un checkpoint.
4. Ensuite seulement, agrandir le disque.

### ClamAV indisponible

Les dépôts restent possibles : les fichiers sont marqués « en attente » et ne sont pas distribués tant qu’ils
ne sont pas analysés ; `files.scan` réessaie automatiquement. `docker compose logs clamav`, puis
`docker compose restart clamav` (2 à 5 min de rechargement des signatures). Mémoire insuffisante → le noyau tue
`clamd` (`dmesg | grep -i oom`) : prévoir 4 Go minimum sur le serveur.

### Bac à sable indisponible

**Console admin › Bac à sable** et **Système › Environnement**. Vérifier la joignabilité TLS de l’hôte distant
(`docker --tlsverify -H tcp://sandbox.internal:2376 info` depuis un poste disposant des certificats) et la date
d’expiration des certificats client. Modèle de menace, topologie et exploitation :
[docs/v4/sandbox.md](v4/sandbox.md).

### Compromission suspectée

1. Isoler : `docker compose stop caddy` (site hors ligne) ; conserver journaux et copie à froid du volume.
2. Révoquer toutes les sessions :
   `docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/alpha.sqlite').exec('DELETE FROM sessions')"`.
3. Faire tourner **tous** les secrets ([ci-dessous](#rotation-des-clés-et-secrets)), en commençant par les clés des
   prestataires de paiement et le mot de passe SMTP.
4. Obligations RGPD : notification à l’autorité de contrôle sous 72 h si des données personnelles sont touchées
   (voir **Console admin › RGPD**).

## Exercice de restauration

À faire **chaque trimestre** et avant toute mise à jour majeure, sur un serveur de recette de préférence.

```bash
cd /opt/alpha/deploy
docker compose exec app npm run backup -- --list                # choisir un jeu : alpha-<horodatage>
docker compose stop app                                         # la restauration refuse une base en cours d’utilisation
docker compose run --rm --no-deps app npm run restore -- /data/backups/alpha-<horodatage>.json --yes
docker compose up -d app
curl -fsS https://<domaine>/api/system/ready
```

Le script de restauration :

- vérifie les sommes SHA-256 de l’archive de base et de l’archive de fichiers, puis `PRAGMA integrity_check` ;
- refuse un schéma plus récent que le code, une base ouverte par un autre processus (`--force` pour passer outre,
  déconseillé) et l’absence de confirmation (`--yes`, ou saisir `oui` dans un terminal) ;
- conserve la base et le dossier de fichiers remplacés (`alpha.sqlite.pre-restore-<horodatage>`,
  `files.pre-restore-<horodatage>`) : supprimez-les une fois la restauration validée ;
- `--no-files` restaure uniquement la base.

**Reprise après sinistre (nouveau serveur).** Installer selon [deployment.md](deployment.md) avec la **même**
`ALPHA_SECRETS_KEY`, sans démarrer l’application, puis :

```bash
docker compose build app && docker compose create          # crée les volumes sans rien démarrer
restic restore latest --tag alpha --target /srv/alpha-restore
SRC=$(find /srv/alpha-restore -type d -name backups | head -n 1)
docker run --rm -v alpha_alpha-data:/data -v "$SRC":/r:ro alpine \
  sh -c 'mkdir -p /data/backups && cp -a /r/. /data/backups/ && chown -R 1000:1000 /data'
docker compose run --rm --no-deps app npm run restore -- --list
docker compose run --rm --no-deps app npm run restore -- /data/backups/<jeu>.json --yes
docker compose up -d
```

Objectif de perte de données : 24 h (sauvegarde quotidienne), à réduire en lançant des
sauvegardes plus fréquentes via un cron hôte (`docker compose exec -T app npm run backup`).

Critères de réussite à consigner : durée totale, `ready` 200, connexion d’un administrateur, ouverture d’un
fichier déposé (vérifie la clé de chiffrement), dernier paiement visible.

## Rotation des clés et secrets

### `ALPHA_SECRETS_KEY`

La clé chiffre (AES-256-GCM) les secrets en base et les fichiers déposés. Chaque valeur chiffrée porte
l’identifiant de sa clé : plusieurs clés peuvent coexister.

1. Sauvegarde : `docker compose exec app npm run backup`.
2. Générer la nouvelle clé : `openssl rand -base64 32` (la ranger dans le gestionnaire de mots de passe).
3. Dans `deploy/.env` : `ALPHA_SECRETS_KEY=<nouvelle>` et `ALPHA_SECRETS_KEY_PREVIOUS=<ancienne>` (liste séparée
   par des virgules si plusieurs).
4. `docker compose up -d app`. Les nouvelles écritures utilisent la nouvelle clé ; les anciennes valeurs restent
   lisibles.
5. Les fichiers sont rechiffrés progressivement par la tâche **`files.rekey`** (active tant que
   `ALPHA_SECRETS_KEY_PREVIOUS` est définie, toutes les 6 h, exécutable depuis la console).
6. Les autres secrets (clés des prestataires, SMTP, MFA, jetons OAuth, documents KYC) ne sont rechiffrés que
   lorsqu’ils sont réenregistrés : **gardez l’ancienne clé dans `ALPHA_SECRETS_KEY_PREVIOUS`**. Si elle est
   compromise, ressaisissez les secrets des prestataires et du SMTP dans la console (ils seront chiffrés avec la
   nouvelle clé) et révoquez-les chez chaque fournisseur.
7. Les sauvegardes antérieures à la rotation nécessitent l’ancienne clé : conservez-la aussi longtemps que ces
   sauvegardes.

### Autres secrets

| Secret | Rotation |
| --- | --- |
| `METRICS_TOKEN` | Nouveau jeton dans `.env` et dans le fichier de jeton Prometheus, `docker compose up -d app`. |
| Clés des prestataires de paiement | Créer la nouvelle clé chez le prestataire, la saisir dans Console admin › Paiements, tester, révoquer l’ancienne. Idem pour les secrets de webhook. |
| SMTP | `SMTP_URL` dans `.env` (puis `up -d app`) ou Console admin › E-mails & notifications. |
| Certificats du bac à sable | Remplacer `deploy/sandbox-docker-certs/*.pem`, `docker compose up -d app`. |
| Comptes administrateurs | Revue trimestrielle de la liste des administrateurs (Console admin › Utilisateurs) et MFA obligatoire. |
| Certificat TLS | Automatique (Caddy, renouvellement ~30 jours avant expiration) ; alerte externe sur l’expiration. |

## Maintenance courante

- **Hebdomadaire** : relire les alertes, les PR Dependabot (CI verte → fusion → mise à jour).
- **Mensuelle** : `docker compose pull caddy clamav && docker compose up -d` (images de proxy/antivirus),
  vérification de l’espace disque et de la taille des sauvegardes hors site.
- **Trimestrielle** : exercice de restauration, revue des administrateurs, test de l’alerte `AlphaBackupStale`
  (désactiver temporairement les sauvegardes sur un serveur de recette).
