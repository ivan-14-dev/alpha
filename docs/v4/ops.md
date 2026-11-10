# V4 — Exploitation (ops)

Mise en production d’Alpha : image Docker, pile Compose, observabilité, sauvegardes, outils d’administration
système. Guides détaillés : [deployment.md](../deployment.md) (installation pas à pas) et
[operations.md](../operations.md) (runbooks, restauration, rotation des clés, alertes).

## Livrables

| Élément | Fichiers |
| --- | --- |
| Image de production | `Dockerfile` (multi-étapes, Node 24 bookworm-slim, `tini`, uid 1000, volume `/data`, HEALTHCHECK sur `/api/system/ready`), `.dockerignore` |
| Pile de production | `deploy/compose.yaml` (app, Caddy, ClamAV ; profils `dev` → Mailpit, `postgres` → PostgreSQL 16), `deploy/Caddyfile`, `deploy/.env.example` |
| Supervision | `deploy/prometheus/prometheus.example.yml`, `deploy/prometheus/alerts.yml` (12 règles) |
| CI | `.github/workflows/ci.yml` (build + tests Node 22/24, `npm audit` non bloquant, image Docker + test de fumée, job PostgreSQL), `.github/dependabot.yml` |
| Serveur | `server/ops/*` (métriques, disponibilité, sauvegardes, contrôles d’environnement), `server/modules/system.ts` |
| Scripts | `npm run backup`, `npm run restore`, `npm run admin:promote` (`scripts/*.ts`) |
| Console | `src/admin/OverviewAdmin.tsx` (Vue d’ensemble), `src/admin/SystemAdmin.tsx` (Système), `src/styles/ops.css` |
| Tests | `tests/ops-v4.test.ts` |

## API `/api/system`

| Méthode et chemin | Accès | Rôle |
| --- | --- | --- |
| `GET /ready` | public | 200 si base joignable, schéma à jour et clé de chiffrement valide ; 503 sinon (`checks` détaille). |
| `GET /metrics` | `Authorization: Bearer $METRICS_TOKEN` | Format texte Prometheus. 404 si le jeton n’est pas défini (ou < 24 caractères), 401 si invalide. |
| `GET /admin/overview` | admin | Comptes, inscriptions 7 j, sessions, campagnes, commandes, paiements, file d’e-mails, fichiers, disque, version, tâches, sauvegardes, audit récent. |
| `GET /admin/backups` · `POST /admin/backups` | admin | Liste · sauvegarde immédiate (auditée `ops.backup_created` / `ops.backup_failed`). |
| `PUT /admin/backups/settings` | admin | Réglage `ops.backup` `{enabled, keep, include_files}` (audité). |
| `GET /admin/jobs` · `POST /admin/jobs/:name/run` | admin | État des tâches · exécution immédiate (auditée `ops.job_run_requested`, 409 si déjà en cours). |
| `GET /admin/settings-audit` | admin | Historique des réglages (`platform_settings.updated_at` / `updated_by`) et 100 derniers événements d’audit d’administrateurs. |
| `GET /admin/environment` | admin | Contrôles : clé de chiffrement, `APP_ORIGIN` HTTPS, SMTP, ClamAV joignable, bac à sable distant, jeton de métriques, tâches, sauvegardes, disque, mode de paiement, SQLite. |

Les routes `admin` exigent une session administrateur (et l’en-tête CSRF pour les mutations). `GET /api/health`
reste la sonde de vie simple.

## Métriques

Compteur `alpha_http_requests_total{method,route,status}` et histogramme
`alpha_http_request_duration_seconds{method,route}` alimentés par `server/ops/observability.ts`. Le libellé
`route` est le **motif** Express capturé au moment de la correspondance (`/api/projects/:id`), les segments
concrets des points de montage sont masqués, les chemins inconnus deviennent `(unmatched)`, et la cardinalité est
plafonnée (`(other)`). Aucune métrique ne porte d’identifiant d’utilisateur, d’adresse e-mail ou d’IP.
S’y ajoutent : tâches (`alpha_job_*`), file d’e-mails par statut, intentions de paiement par statut et mode
(si la table existe), taille de la base / du WAL, version du schéma, dernière sauvegarde, comptes et sessions,
mémoire et temps de fonctionnement du processus.

## Sauvegardes

`server/ops/backup-core.ts` : copie cohérente à chaud par `VACUUM INTO`, `PRAGMA integrity_check`, gzip,
empreintes `.sha256`, archive tar.gz de `FILES_DIR` (fichiers déjà chiffrés), manifeste `.json` écrit en
dernier (un jeu sans manifeste est incomplet), rotation. La tâche **`ops.backup`** est vérifiée toutes les heures
et crée une sauvegarde si la dernière date de plus de 24 h ; activée par défaut en production, 14 jeux
conservés. La restauration vérifie empreintes et intégrité, refuse un schéma plus récent que le code et une base
utilisée par un autre processus (sonde de verrou exclusif), exige `--yes` (ou la saisie de `oui`) et conserve
une copie `*.pre-restore-<horodatage>` de la base et des fichiers remplacés.

## Configuration

Toutes les variables sont commentées dans [`/.env.example`](../../.env.example) ; production :
[`deploy/.env.example`](../../deploy/.env.example). Variables propres à ce module : `METRICS_TOKEN`,
`BACKUP_DIR` (défaut `<dossier de la base>/backups`), `LOG_LEVEL`, `LOG_FORMAT`. L’image fixe `NODE_ENV=production`,
`HOST=0.0.0.0`, `DATABASE_PATH=/data/alpha.sqlite`, `FILES_DIR=/data/files`, `BACKUP_DIR=/data/backups`,
`ALPHA_SANDBOX_WORK_DIR=/data/sandbox-work`.

## Arrêt propre

`server/index.ts` : sur `SIGTERM`/`SIGINT`, arrêt des tâches planifiées, fermeture des flux temps réel
(`closeAllStreams`), fermeture des connexions inactives, 8 s maximum pour les requêtes en cours (puis fermeture
forcée), fermeture de la base (checkpoint du WAL) et sortie. Docker envoie `SIGKILL` après 10 s par défaut
(20 s dans `compose.yaml`).

## Sécurité

- Conteneur non root, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`.
- **Jamais** de socket Docker de l’hôte dans `app` : le bac à sable utilise un hôte Docker distant en TLS
  (`ALPHA_SANDBOX_DOCKER_HOST`) ; l’environnement signale une erreur si un socket local est utilisé en production.
- Caddy : HTTPS automatique, HSTS, `Permissions-Policy`, COOP, retrait de `Server` ; l’application garde la main
  sur la CSP et les autres en-têtes. `/api/system/metrics` est en plus bloqué (404) pour les adresses publiques.
- `promote-admin` n’existe qu’en ligne de commande (aucune route d’auto-promotion) et laisse une trace d’audit.
- Les sauvegardes contiennent des données personnelles et des secrets chiffrés : copie hors site chiffrée
  (restic, rclone crypt) ; `ALPHA_SECRETS_KEY` conservée à part.

## Limites

- SQLite, nœud unique : pas de mise à l’échelle horizontale ni de déploiement sans interruption (redémarrage de
  quelques secondes ; les navigateurs reconnectent leurs flux temps réel automatiquement).
- Les migrations sont à sens unique : le retour arrière passe par la restauration de la sauvegarde prise avant la
  mise à jour.
- Les métriques HTTP sont en mémoire et repartent de zéro à chaque redémarrage (compteurs Prometheus classiques).
- Les secrets autres que les fichiers ne sont pas rechiffrés automatiquement après une rotation de
  `ALPHA_SECRETS_KEY` : l’ancienne clé doit rester dans `ALPHA_SECRETS_KEY_PREVIOUS`.
- Les hôtes Docker `ssh://` ne sont pas pris en charge par l’image (TCP + TLS uniquement).
