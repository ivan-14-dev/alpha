# Déployer Alpha en production

Ce guide installe Alpha sur un serveur unique (VPS) avec Docker Compose : l’application, le proxy **Caddy**
(HTTPS automatique), l’antivirus **ClamAV**, et en option **Mailpit** (tests d’e-mails) et **PostgreSQL**
(cible de l’outil d’export). Les procédures d’exploitation (incidents, restauration, rotation de clés, alertes)
sont dans [operations.md](operations.md).

```
Internet ──443/80──▶ caddy ──▶ app:3001 (Node 24, SQLite dans le volume /data) ──▶ clamav:3310
                                   │
                                   └──TLS──▶ hôte Docker distant (bac à sable, optionnel)
```

> **Limites assumées d’une instance SQLite unique.** Une seule instance de l’application écrit dans la base :
> pas de mise à l’échelle horizontale, pas de déploiement sans interruption (chaque mise à jour redémarre le
> conteneur : quelques secondes d’indisponibilité, les flux temps réel se reconnectent automatiquement).
> Pour la haute disponibilité, la feuille de route passe par l’export PostgreSQL (`npm run db:export:postgres`).

## 1. Serveur

| Ressource | Minimum | Recommandé |
| --- | --- | --- |
| vCPU | 2 | 4 |
| Mémoire | 4 Go (ClamAV seul consomme ~1,5 Go, ~3 Go pendant le rechargement des signatures) | 8 Go |
| Disque | 40 Go SSD | 80 Go+ selon le volume de fichiers déposés (fichiers + 14 sauvegardes locales) |

- Debian 12/13 ou Ubuntu 24.04 LTS, à jour, mises à jour de sécurité automatiques (`unattended-upgrades`).
- Docker Engine ≥ 27 et le plugin Compose v2 : <https://docs.docker.com/engine/install/>.
- Pare-feu : seuls **22/tcp** (SSH, clés uniquement), **80/tcp**, **443/tcp** et **443/udp** (HTTP/3) ouverts.
  Docker publie les ports en contournant `ufw` : ne publiez rien d’autre que Caddy (c’est le cas de `compose.yaml`).
- Horloge synchronisée (NTP) : indispensable pour les jetons MFA, les webhooks signés et les certificats.

## 2. DNS

Créez un enregistrement **A** (et **AAAA** si le serveur a de l’IPv6) pour votre domaine, par exemple
`alpha.example.org`, pointant vers le serveur. Caddy obtient le certificat TLS dès que le DNS répond et que les
ports 80/443 sont joignables. Pour rediriger `www.`, ajoutez aussi son enregistrement et décommentez le bloc
correspondant de `deploy/Caddyfile`.

> IPv6 : si le réseau Docker n’a pas l’IPv6 activé, les clients IPv6 arrivent sur Caddy avec l’adresse de la
> passerelle Docker (le `docker-proxy` traduit la connexion). Les limites de débit et les journaux d’audit
> verraient alors une seule adresse. Activez l’IPv6 sur le réseau du projet (`networks: default: enable_ipv6: true`
> dans un fichier `compose.override.yaml`) ou n’annoncez pas d’AAAA.

## 3. Récupérer le code et configurer

```bash
sudo mkdir -p /opt/alpha && sudo chown "$USER" /opt/alpha
git clone https://github.com/<organisation>/alpha.git /opt/alpha
cd /opt/alpha && git checkout v0.4.0          # toujours une version étiquetée en production
cd deploy
cp .env.example .env && chmod 600 .env
```

Générez les secrets et reportez-les dans `deploy/.env` :

```bash
openssl rand -base64 32   # ALPHA_SECRETS_KEY  (32 octets, chiffrement des secrets et des fichiers)
openssl rand -hex 32      # METRICS_TOKEN      (accès Prometheus à /api/system/metrics)
```

Variables à renseigner au minimum :

| Variable | Exemple | Rôle |
| --- | --- | --- |
| `ALPHA_DOMAIN` | `alpha.example.org` | Domaine servi par Caddy (certificat automatique). |
| `ACME_EMAIL` | `ops@example.org` | Contact Let’s Encrypt (expiration, incidents). |
| `APP_ORIGIN` | `https://alpha.example.org` | Origine publique : liens des e-mails, contrôle CSRF, retours OAuth. |
| `ALPHA_SECRETS_KEY` | sortie de `openssl rand -base64 32` | **Obligatoire.** Chiffre clés de paiement, mot de passe SMTP, secrets MFA, jetons OAuth, documents KYC et fichiers. |
| `SMTP_URL`, `MAIL_FROM` | `smtps://user:pass@smtp.example.org:465` | Envoi des e-mails (vérification, réinitialisation, notifications). |
| `METRICS_TOKEN` | sortie de `openssl rand -hex 32` | Facultatif : active `/api/system/metrics`. |

> **Conservez `ALPHA_SECRETS_KEY` dans un gestionnaire de mots de passe, hors du serveur.** Elle n’est pas
> incluse dans les sauvegardes. Sans elle, une sauvegarde restaurée n’a plus accès aux secrets chiffrés ni aux
> fichiers déposés. La liste complète des variables est commentée dans [`/.env.example`](../.env.example).

`compose.yaml` fixe lui-même `NODE_ENV=production`, `HOST`, `PORT`, `DATABASE_PATH=/data/alpha.sqlite`,
`FILES_DIR=/data/files`, `BACKUP_DIR=/data/backups`, `TRUST_PROXY=1` (exactement un proxy : Caddy) et
`CLAMAV_HOST=clamav`.

## 4. Démarrer

```bash
cd /opt/alpha/deploy
docker compose up -d --build
docker compose ps                       # app « healthy », caddy « running », clamav « healthy » après ~5 min
curl -fsS https://alpha.example.org/api/system/ready
```

- `app` démarre en utilisateur non privilégié (uid 1000), système de fichiers en lecture seule, toutes
  capacités Linux retirées ; seules `/data` (volume `alpha_alpha-data`) et `/tmp` (tmpfs) sont inscriptibles.
- Les migrations de schéma s’appliquent automatiquement au démarrage.
- `/api/system/ready` répond 200 quand la base répond, que le schéma est à jour et que la clé de chiffrement est
  valide (503 sinon) ; c’est aussi le contrôle de santé Docker. `/api/health` est la sonde de vie simple.
- ClamAV télécharge ses signatures au premier démarrage (plusieurs minutes, volume `alpha_clamav-db`). Les
  fichiers déposés entre-temps restent « en attente d’analyse » puis sont analysés automatiquement.

`ALPHA_IMAGE` (dans `.env`) nomme l’image construite d’après la version déployée : chaque version garde ainsi sa
propre image locale, ce qui rend le retour arrière immédiat ([§ 12](#revenir-en-arrière)).

Construire sur le serveur est le plus simple. Pour publier l’image depuis la CI ou un poste de build, poussez-la
dans un registre et indiquez `ALPHA_IMAGE=ghcr.io/<organisation>/alpha-platform:0.4.0` dans `.env`, puis
`docker compose pull app && docker compose up -d`.

## 5. Premier administrateur

1. Créez votre compte sur `https://alpha.example.org/register` et validez l’adresse e-mail.
2. Promouvez-le :

   ```bash
   docker compose exec app npm run admin:promote -- vous@example.org
   ```

3. Reconnectez-vous : la **Console admin** apparaît dans la navigation (`/admin`). Activez immédiatement la
   double authentification sur ce compte. Chaque promotion est tracée dans le journal d’audit (sans acteur, car
   faite en ligne de commande) ; aucune route HTTP ne permet de s’auto-promouvoir.

## 6. Paiements

Configurez les prestataires dans **Console admin › Paiements** (les clés sont chiffrées avec
`ALPHA_SECRETS_KEY`). Pour chaque prestataire, déclarez dans son tableau de bord l’URL de webhook affichée par la
console, de la forme :

```
https://alpha.example.org/api/payments/webhooks/<prestataire>      # stripe, flutterwave, campay, wave, orange-money, mtn-momo, kratos-pay…
```

Si les webhooks doivent arriver sur un autre domaine que l’application, définissez `PUBLIC_API_ORIGIN`.
Les connecteurs d’intégration utilisent de la même façon `…/api/integrations/webhooks/<fournisseur>/<source>`
et la connexion OAuth `https://alpha.example.org/api/auth/oauth/<fournisseur>/callback`.

> Le passage en mode **live** exige une confirmation explicite d’un administrateur. Détenir des fonds pour le
> compte de tiers (séquestre, portefeuilles) peut nécessiter un agrément de paiement / monnaie électronique ou un
> partenaire régulé (UE : DSP2/DME2 ; CEMAC : COBAC/BEAC ; UEMOA : BCEAO). Privilégiez les produits « marketplace »
> des prestataires (Stripe Connect, sous-comptes Flutterwave…) et faites valider vos textes légaux par un avocat.

## 7. E-mails

- **Production** : `SMTP_URL` (`smtps://` port 465 ou `smtp://` + STARTTLS port 587) et `MAIL_FROM`, ou bien
  **Console admin › E-mails & notifications**. Publiez SPF, DKIM et DMARC pour le domaine d’envoi, sinon les messages finiront en
  indésirables. Les envois passent par une file (`email_outbox`) réessayée par la tâche `mail.deliver`.
- **Recette** : `docker compose --profile dev up -d mailpit`, `SMTP_URL=smtp://mailpit:1025`, puis interface sur
  `http://127.0.0.1:8025` (tunnel SSH : `ssh -L 8025:127.0.0.1:8025 serveur`). Jamais en production.

## 8. Antivirus (ClamAV)

Le service `clamav` (image `clamav/clamav:stable`) est joint par `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`. Un
réglage enregistré dans **Console admin › Fichiers & antivirus** a priorité sur ces variables. Vérifiez l’état dans
**Console admin › Système › Environnement** (« ClamAV joignable »). Les signatures sont mises à jour par
`freshclam` dans le conteneur.

Les builds de campagne peuvent atteindre 200 Mo alors que clamd limite par défaut un flux à 100 Mo : le fichier
`deploy/clamav/clamd.conf` (monté par `compose.yaml`) relève `StreamMaxLength`, `MaxFileSize` et `MaxScanSize`.
Gardez `CLAMAV_TIMEOUT_MS=120000` pour les gros fichiers. Détails : [docs/v4/files.md](v4/files.md).

## 9. Bac à sable (exécution isolée des logiciels testés)

Le module sandbox lance des conteneurs via la CLI Docker incluse dans l’image. **Ne montez jamais
`/var/run/docker.sock` dans `app`** : un conteneur qui contrôle le démon de l’hôte contrôle l’hôte entier, base
de données et clés comprises. Utilisez un **hôte Docker distant dédié**, sans autre donnée, joint en TCP + TLS
mutuel :

1. Sur l’hôte sandbox, exposez le démon en TLS (`dockerd --tlsverify --tlscacert=ca.pem --tlscert=server-cert.pem
   --tlskey=server-key.pem -H tcp://0.0.0.0:2376`, procédure : <https://docs.docker.com/engine/security/protect-access/>)
   et n’autorisez le port 2376 qu’à l’adresse du serveur Alpha.
2. Copiez les certificats client (`ca.pem`, `cert.pem`, `key.pem`) dans `deploy/sandbox-docker-certs/`
   (`chmod 600`, lisibles par l’uid 1000) et décommentez le montage correspondant dans `compose.yaml`.
3. Dans `.env` :

   ```
   ALPHA_SANDBOX_DOCKER_HOST=tcp://sandbox.internal:2376
   ALPHA_SANDBOX_DOCKER_TLS_VERIFY=1
   ALPHA_SANDBOX_DOCKER_CERT_PATH=/run/secrets/sandbox-docker
   ALPHA_SANDBOX_IMAGE_ALLOWLIST=alpine,node,python,eclipse-temurin
   ```

   Le verrou doit couvrir les images des profils (un dépôt nu autorise tous ses tags épinglés, un tag exact
   n’autorise que lui) ; voir [docs/v4/sandbox.md](v4/sandbox.md) (modèle de menace, profils, exploitation).
   **Une seule instance de l’application doit exécuter les tâches** (`ALPHA_JOBS=off` sur les autres) : une exécution
   appartient au processus qui l’a réservée.

Les URL `ssh://` ne sont pas prises en charge par l’image (pas de client SSH). Le statut apparaît dans
**Console admin › Système › Environnement** (erreur si un socket local est utilisé en production).

## 10. Sauvegardes

La tâche **`ops.backup`** (vérifiée toutes les heures) crée une sauvegarde par jour dans `/data/backups` :

- base copiée à chaud et de façon cohérente (`VACUUM INTO`), compressée (`alpha-<horodatage>.sqlite.gz`) ;
- archive des fichiers déposés (`.files.tar.gz`, déjà chiffrés par l’application) ;
- empreintes `.sha256` et manifeste `.json` écrit en dernier ;
- rotation : 14 jeux conservés par défaut (réglable dans **Console admin › Système › Sauvegardes**) ;
- activée par défaut quand `NODE_ENV=production` (cas de l’image Docker).

Sauvegarde manuelle (par exemple avant une mise à jour) :

```bash
docker compose exec app npm run backup
docker compose exec app npm run backup -- --list
```

### Copie hors site (obligatoire)

Une sauvegarde sur le même disque ne protège ni d’une panne du serveur ni d’un rançongiciel. Les sauvegardes
contiennent des données personnelles : **chiffrez-les** côté client. Exemple avec
[restic](https://restic.net/) et un stockage S3 (cron ou timer systemd quotidien, après la sauvegarde locale) :

```bash
# /etc/alpha/restic.env (chmod 600) : RESTIC_REPOSITORY=s3:https://s3.example.net/alpha-backups
#                                     RESTIC_PASSWORD=…  AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…
BACKUPS=$(docker volume inspect alpha_alpha-data --format '{{ .Mountpoint }}')/backups
set -a; . /etc/alpha/restic.env; set +a
restic backup --tag alpha "$BACKUPS"
restic forget --tag alpha --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
restic check --read-data-subset=5%
```

Avec [rclone](https://rclone.org/), utilisez un remote **crypt** :
`rclone sync "$BACKUPS" alpha-crypt:backups --max-age 8d`.
Gardez `ALPHA_SECRETS_KEY` et le mot de passe restic **ailleurs** que dans le dépôt de sauvegarde, et testez une
restauration chaque trimestre ([operations.md › Exercice de restauration](operations.md#exercice-de-restauration)).

## 11. Supervision

- Sonde externe (Uptime Kuma, Better Stack…) sur `https://alpha.example.org/api/system/ready`.
- Prometheus : `/api/system/metrics` exige `Authorization: Bearer <METRICS_TOKEN>` (404 si le jeton n’est pas
  défini). Caddy renvoie en plus 404 aux adresses publiques : grattez depuis le réseau privé ou un conteneur
  rattaché au réseau `alpha_default` (`http://app:3001/api/system/metrics`). Règles d’alerte prêtes à l’emploi :
  [operations.md › Alertes](operations.md#alertes-prometheus).
- Journaux : JSON sur la sortie standard (`docker compose logs -f app`), rotation 5 × 20 Mo par service. Chaque
  requête porte un identifiant `X-Request-Id`, renvoyé au client et repris dans les journaux.

## 12. Mettre à jour

```bash
cd /opt/alpha
docker compose -f deploy/compose.yaml exec app npm run backup        # point de retour
git fetch --tags && git checkout v0.4.1
sed -i 's/^ALPHA_IMAGE=.*/ALPHA_IMAGE=alpha-platform:0.4.1/' deploy/.env   # l’image 0.4.0 reste disponible
cd deploy && docker compose build app && docker compose up -d
docker compose ps && curl -fsS https://alpha.example.org/api/system/ready
```

Lisez les notes de version avant de mettre à jour : les migrations sont **à sens unique**.

### Revenir en arrière

Si la nouvelle version a déjà migré le schéma, l’ancienne refusera de démarrer sur cette base : il faut
restaurer la sauvegarde prise juste avant la mise à jour (le script refuse une sauvegarde plus récente que le
code).

```bash
cd /opt/alpha/deploy
docker compose stop app
sed -i 's/^ALPHA_IMAGE=.*/ALPHA_IMAGE=alpha-platform:0.4.0/' .env && git checkout v0.4.0
docker image inspect alpha-platform:0.4.0 >/dev/null || docker compose build app
docker compose run --rm --no-deps app npm run restore -- --list
docker compose run --rm --no-deps app npm run restore -- /data/backups/alpha-<horodatage>.json --yes
docker compose up -d
```

Les écritures faites entre la sauvegarde et le retour arrière sont perdues : planifiez les mises à jour dans un
créneau calme et prévenez les utilisateurs (l’indisponibilité dure le temps d’un redémarrage).

## 13. Export PostgreSQL (facultatif)

Le profil `postgres` démarre un PostgreSQL 16 joignable uniquement depuis le réseau interne (`postgres:5432`),
cible de l’outil d’export (options : `npm run db:export:postgres -- --help`). Définissez `POSTGRES_PASSWORD`
dans `.env`, puis :

```bash
docker compose --profile postgres up -d postgres
docker compose run --rm --no-deps \
  -e ALPHA_PG_URL="postgres://alpha:<mot de passe>@postgres:5432/alpha" app npm run db:export:postgres -- --drop
```

La base SQLite est ouverte en lecture seule : l’export peut tourner pendant que l’application fonctionne. Sans
`--drop`, un nouvel export vers un schéma `alpha` non vide est refusé (code de sortie 2). Détails, options, codes de
sortie et limites : [postgresql.md](postgresql.md).
