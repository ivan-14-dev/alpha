# Bac à sable d’exécution (V4)

Le bac à sable permet de lancer un build joint à une campagne de test dans un conteneur Docker jetable et isolé, puis de partager le journal
d’exécution entre le porteur du projet et ses testeurs.

Il **complète** les tests manuels, il ne les remplace pas. Il sert à vérifier qu’un build démarre, à exécuter les tests automatisés fournis par le
projet et à obtenir un journal reproductible. Les applications graphiques et mobiles ne sont pas encore prises en charge (voir « Limites et feuille de
route »).

Le module est **désactivé par défaut**. Un administrateur doit l’activer explicitement (Administration › Bac à sable), idéalement après avoir
branché un démon Docker dédié (voir « Topologie de production recommandée »).

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Migration | `server/migrations/010-sandbox.sql` (`sandbox_runs`, `sandbox_daily_usage`) |
| API | `server/modules/sandbox.ts` (`/api/sandbox/*`) |
| Configuration et validation | `server/sandbox/config.ts` (réglage `sandbox.config`) |
| Cycle de vie, file, jobs, données personnelles | `server/sandbox/service.ts` |
| Exécuteur Docker | `server/sandbox/docker.ts` |
| Interface d’exécuteur (injectable) | `server/sandbox/runner.ts` |
| Journal plafonné et nettoyé | `server/sandbox/logs.ts` |
| Script d’entrée dans le conteneur | `sandbox/entry.sh` |
| Interface | `src/pages/SandboxPage.tsx` (`/sandbox`, `/sandbox/:id`), `src/admin/SandboxAdmin.tsx`, `src/styles/sandbox.css` |
| Tests | `tests/sandbox-v4.test.ts` |

## Modèle de menace

Un build de campagne est du **code non fiable**. Il a été déposé par un porteur de projet, et il peut être malveillant, piégé ou simplement bogué.
Le bac à sable part du principe que ce code essaiera tout ce qui est possible.

| Menace | Exemple | Contre-mesures |
| --- | --- | --- |
| **Évasion du conteneur** | Exploit noyau, abus d’une capacité Linux, binaire setuid, accès au socket Docker | Utilisateur non privilégié `65534:65534` ; `--cap-drop ALL` ; `--security-opt no-new-privileges` ; tmpfs montés `nosuid,nodev` ; racine en lecture seule ; aucun montage du socket Docker ; seccomp et AppArmor par défaut de Docker ; runtime OCI renforcé optionnel (`runsc` de gVisor, Kata) ; démon dédié sur une VM séparée en production |
| **Épuisement des ressources** | Fork bomb, fuite mémoire, boucle infinie, bombe de décompression, flot de journaux | `--pids-limit`, `--memory` et `--memory-swap` égaux (pas de swap), `--cpus`, `--ulimit nofile/nproc/core`, tmpfs de taille fixe, délai maximal puis `docker kill`, minuterie interne `timeout -s KILL`, journal plafonné à 256 Ko, nombre d’exécutions simultanées (`max_concurrent`), quota quotidien par membre, nombre de demandes en attente par membre, taille maximale du build |
| **Exfiltration de données** | Envoi des fichiers, de variables d’environnement ou de secrets vers l’extérieur ; lecture des builds d’autres campagnes | `--network none` ; aucun secret transmis (environnement du conteneur réduit à `HOME`, `TMPDIR`, `LANG` et aux variables `ALPHA_*` techniques) ; le client Docker reçoit lui aussi un environnement minimal ; un seul build monté, en lecture seule, dans un dossier propre à l’exécution (0700 et 0400) supprimé à la fin ; journaux filtrés (`sanitizeLog`) |
| **Minage de cryptomonnaie et abus de calcul** | Mineur caché dans un « test » | Pas de réseau (pas de pool joignable), CPU plafonné, délai maximal, quota quotidien, file d’attente expirée après 24 h, journal d’audit |
| **Images piégées** | Image modifiée sur le registre, tag `latest` qui change | Images **épinglées** (`nom:tag` différent de `latest`, ou digest `sha256`) et présentes dans une **liste blanche** ; `--pull never` (une image n’est téléchargée que par un administrateur, depuis la console) ; liste blanche verrouillable par variable d’environnement |
| **Injection de commande** | Nom de fichier ou argument malveillant | `docker` est lancé avec `child_process.spawn` et un tableau d’arguments, **jamais** une chaîne shell ; nom du build normalisé (`safeBuildName`) puis revérifié par `entry.sh` ; les variables `{input}`, `{app}` et `{entry}` doivent occuper un argument entier |
| **Accès non autorisé** | Un membre lance ou lit l’exécution d’une campagne qui ne le concerne pas | Seuls le propriétaire de la campagne et les testeurs dont la candidature ou la mission est acceptée peuvent lancer une exécution ; une exécution est visible par son demandeur, le propriétaire de la campagne et les administrateurs ; capacité `test` exigée ; limite de débit |

### Pourquoi aucun accès réseau

Le réseau est coupé (`--network none`) pour toutes les exécutions, sans option pour le rétablir. Le conteneur ne voit que l’interface `lo`. Ce choix
élimine d’un coup :

- l’exfiltration de données ;
- le téléchargement d’une seconde charge malveillante ;
- le minage, puisque aucun pool n’est joignable ;
- les attaques contre le réseau interne de l’hébergeur (métadonnées cloud `169.254.169.254`, bases de données, services d’administration) ;
- l’utilisation de la plateforme pour attaquer des tiers (scan, déni de service, spam).

La contrepartie est que **les dépendances doivent être embarquées dans le build** : pas de `npm install`, `pip install` ni `mvn`. Les porteurs de
projet fournissent une archive autonome (dossier `node_modules` inclus, bibliothèques Python embarquées, JAR « fat »…).

## Isolation appliquée à chaque exécution

Arguments `docker run` construits par `dockerRunArgs()` (vérifiés un par un par les tests) :

| Option | Effet |
| --- | --- |
| `--rm`, `--name alpha-sbx-<id>`, `--label alpha.sandbox=1`, `--label alpha.sandbox.instance=<instance>`, `--label alpha.sandbox.run=<id>` | Conteneur jetable et identifiable, retrouvé au redémarrage puis supprimé s’il est orphelin |
| `--pull never` | Aucun téléchargement implicite d’image |
| `--log-driver none` | Le démon ne conserve pas les journaux ; Alpha les lit sur la sortie standard, avec un plafond |
| `--init` | Un mini-init récupère les processus zombies et transmet les signaux |
| `--network none`, `--hostname sandbox`, `--ipc private` | Pas de réseau ni d’IPC partagée |
| `--read-only` | Système de fichiers racine en lecture seule |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | Aucune capacité Linux, pas d’élévation par setuid |
| `--user 65534:65534` | Utilisateur `nobody`, jamais root |
| `--pids-limit N` | Plafond du nombre de processus (fork bomb) |
| `--memory Xm --memory-swap Xm` | Mémoire bornée, sans swap |
| `--cpus Y` | Part de CPU bornée |
| `--oom-score-adj 500` | En cas de pression mémoire sur l’hôte, le conteneur est tué en premier |
| `--ulimit nofile=256:256`, `--ulimit nproc=…`, `--ulimit core=0:0` | Descripteurs, processus par uid, pas de fichier core |
| `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=…` | Petit espace temporaire non exécutable (¼ du tmpfs du profil, entre 8 et 64 Mo) |
| `--tmpfs /work:rw,exec,nosuid,nodev,size=…,uid=65534,gid=65534,mode=0700` | Espace de travail : copie du build et extraction des archives |
| `--workdir /work`, `--env HOME=/work`, `--env TMPDIR=/tmp` | Environnement minimal, sans secret |
| `--runtime <oci_runtime>` (optionnel) | Par exemple `runsc` (gVisor) ou `kata-runtime` |
| `--volume <dossier>/input:/input:ro`, `--volume entry.sh:/sandbox/entry.sh:ro` (mode `bind`) | Build et script d’entrée en lecture seule |
| `--interactive` et `sh -c <entry.sh>` (mode `stdin`) | Pour un démon distant : le build est envoyé sur l’entrée standard, sans montage de fichier hôte |

Le délai est appliqué deux fois :

1. Côté serveur : à l’échéance, Alpha lance `docker kill`, puis l’exécution passe au statut `timeout`.
2. Dans le conteneur : `entry.sh` lance le programme sous `timeout -s KILL` (délai + 10 s). Le programme est donc tué même si le processus Alpha
   meurt pendant l’exécution.

## Topologie de production recommandée

```
┌──────────────────────────┐          TLS mutuel (2376)          ┌────────────────────────────────────┐
│ Hôte applicatif           │ ──────────────────────────────────▶ │ VM « sandbox » dédiée              │
│  Alpha (Node) + client    │  ALPHA_SANDBOX_DOCKER_HOST=         │  dockerd (+ gVisor runsc / Kata)   │
│  docker uniquement         │  tcp://sandbox.interne:2376         │  aucun secret, aucune donnée Alpha │
│  PAS de /var/run/docker.sock│                                    │  sortie réseau bloquée (pare-feu)  │
└──────────────────────────┘                                      └────────────────────────────────────┘
```

1. **Démon dédié sur une VM ou un hôte séparé.** Le démon Docker qui exécute le code non fiable ne doit héberger ni la base de données, ni les
   fichiers, ni les secrets d’Alpha. Une évasion du conteneur ne donne alors accès qu’à une machine jetable.
2. **Ne jamais monter le socket Docker** (`/var/run/docker.sock`) dans le conteneur de l’application web. Ce socket équivaut à un accès root sur
   l’hôte. Exposez plutôt le démon de la VM sandbox en TCP avec **TLS mutuel** (`--tlsverify`, certificats client et serveur) et donnez son adresse à
   Alpha :

   ```sh
   ALPHA_SANDBOX_DOCKER_HOST=tcp://sandbox.interne:2376
   ALPHA_SANDBOX_DOCKER_TLS_VERIFY=1
   ALPHA_SANDBOX_DOCKER_CERT_PATH=/run/secrets/sandbox-docker   # ca.pem, cert.pem, key.pem
   ```

   Avec un démon distant, le mode de transmission `auto` choisit `stdin` : le build est envoyé par le flux de `docker run -i`, puisque les chemins de
   l’hôte applicatif n’existent pas sur la VM.
3. **Runtime renforcé.** Installez gVisor (`runsc`) ou Kata Containers sur la VM sandbox, puis indiquez `runsc` (ou `kata-runtime`) dans le champ
   « Runtime OCI » de la console. Le noyau de l’hôte n’est alors plus directement exposé aux appels système du build. Le bouton « Tester » vérifie
   que le runtime est déclaré par le démon.
4. **Durcissement du démon** (`/etc/docker/daemon.json` sur la VM sandbox) :

   ```json
   {
     "userns-remap": "default",
     "no-new-privileges": true,
     "icc": false,
     "live-restore": false,
     "log-driver": "none",
     "default-ulimits": { "nofile": { "Name": "nofile", "Soft": 256, "Hard": 256 } },
     "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } }
   }
   ```

   `userns-remap` associe l’uid 0 du conteneur à un uid non privilégié de l’hôte. Le mode rootless de Docker est une alternative.
5. **Pare-feu de sortie** sur la VM : n’autorisez que le registre d’images (au moment des téléchargements) et le port TLS du démon depuis l’hôte
   applicatif. C’est une défense en profondeur : `--network none` coupe déjà le réseau des conteneurs.
6. **Registre maîtrisé** : de préférence un miroir interne (`registry.interne/alpha/node:22-alpine`), déclaré dans la liste blanche, avec des images
   épinglées par digest.
7. **Une seule instance** de l’application exécute le job `sandbox.dispatch` (comme les autres jobs de la plateforme). Si plusieurs plateformes
   partagent le même démon, donnez à chacune un `ALPHA_SANDBOX_INSTANCE` distinct. La récupération au démarrage ne supprime alors que les conteneurs
   de sa propre instance.

En développement, le démon local suffit (`unix:///var/run/docker.sock` sur la machine du développeur). La console affiche un avertissement tant
que le démon est local, et l’activation demande une confirmation.

## Variables d’environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `ALPHA_SANDBOX_DOCKER_HOST` | `DOCKER_HOST`, sinon le socket local | Adresse du démon sandbox (par exemple `tcp://sandbox.interne:2376`) |
| `ALPHA_SANDBOX_DOCKER_TLS_VERIFY`, `ALPHA_SANDBOX_DOCKER_CERT_PATH` | `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` | TLS mutuel vers le démon distant |
| `ALPHA_SANDBOX_DOCKER_CONFIG` | — | Dossier de configuration du client Docker (identifiants de registre privé) |
| `ALPHA_SANDBOX_DOCKER_BIN` | `docker` | Chemin du client Docker |
| `ALPHA_SANDBOX_WORK_DIR` | `data/sandbox-work` | Dossiers temporaires par exécution (mode `bind`), en 0700 |
| `ALPHA_SANDBOX_ENTRY` | `sandbox/entry.sh` | Script d’entrée monté en lecture seule |
| `ALPHA_SANDBOX_IMAGE_ALLOWLIST` | — | Liste blanche séparée par des virgules (par exemple `alpine:3.20,node:22-alpine` pour n’autoriser que ces versions exactes, ou `alpine,node`). Si elle est définie, elle **verrouille** celle de la console. Les entrées invalides sont ignorées et signalées dans le journal (`sandbox.allowlist_entries_ignored`) |
| `ALPHA_SANDBOX_INSTANCE` | empreinte de `APP_ORIGIN` | Étiquette des conteneurs de cette plateforme sur un démon partagé |

L’adresse du démon ne vient **jamais** de la console d’administration : un compte administrateur compromis ne peut pas rediriger les builds vers
un démon arbitraire.

## Configuration (réglage `sandbox.config`)

Modifiable dans Administration › Bac à sable (`PUT /api/sandbox/admin/config`, audité sous `sandbox.config_updated`).

| Champ | Défaut | Bornes | Rôle |
| --- | --- | --- | --- |
| `enabled` | `false` | — | Interrupteur général |
| `runtime` | `docker` | `docker` ou `disabled` | `disabled` coupe l’exécution sans perdre la configuration |
| `oci_runtime` | `null` | `[a-z][a-z0-9._-]{0,39}` | Runtime OCI optionnel (`runsc`, `kata-runtime`) |
| `input_mode` | `auto` | `auto`, `bind`, `stdin` | Transmission du build (`auto` : `bind` en local, `stdin` à distance) |
| `max_concurrent` | 2 | 1 à 32 | Exécutions simultanées sur la plateforme |
| `daily_quota` | 20 | 1 à 1000 | Exécutions par membre et par jour (UTC) |
| `max_pending_per_user` | 3 | 1 à 20 | Exécutions en attente ou en cours par membre |
| `max_build_mb` | 100 | 1 à 1024 | Taille maximale d’un build exécutable |
| `require_clean_scan` | `false` | — | Exiger un build analysé et sain, même quand l’analyse antivirus n’est pas obligatoire (`files.require_scan`) |
| `log_retention_days` | 30 | 1 à 3650 | Après ce délai, le journal et le journal étendu sont supprimés ; les métadonnées sont conservées |
| `run_retention_days` | 180 | 1 à 3650, ≥ journaux | Après ce délai, l’exécution est supprimée |
| `allowed_images` | `alpine`, `node`, `python`, `eclipse-temurin` | 1 à 50 entrées | Liste blanche : dépôt, version exacte (`nom:tag` sauf `latest`, ou `@sha256:…`) ou préfixe `…/*` |
| `profiles` | voir ci-dessous | 0 à 30 | Environnements d’exécution |

Limites par profil : `timeout_s` de 5 à 3600, `memory_mb` de 32 à 8192, `cpus` de 0,1 à 8, `pids` de 16 à 4096, `tmpfs_mb` de 8 à 4096.

### Profils par défaut

| Profil | Image | Commande | Points d’entrée d’archive | Délai, mémoire, CPU, processus, tmpfs |
| --- | --- | --- | --- | --- |
| `linux-shell` | `alpine:3.20` | `{entry}` | `alpha-test.sh`, `test.sh`, `run.sh`, `start.sh` | 60 s, 256 Mo, 0,5, 64, 128 Mo |
| `node` | `node:22-alpine` | `node {entry}` | `alpha-test.js`, `test.js`, `index.js`, `main.js`, `server.js`, `app.js`, `index.mjs`, `dist/index.js`, `src/index.js` | 120 s, 512 Mo, 1, 128, 256 Mo |
| `python` | `python:3.12-alpine` | `python -B -E -s {entry}` | `alpha_test.py`, `test.py`, `main.py`, `app.py`, `__main__.py`, `src/main.py` | 120 s, 512 Mo, 1, 128, 256 Mo |
| `java` | `eclipse-temurin:21-jre-alpine` | `java -XX:+UseSerialGC -XX:MaxRAMPercentage=75 -XX:-UsePerfData -Djava.io.tmpdir=/tmp -jar {input}` | aucun (JAR non extrait) | 120 s, 768 Mo, 1, 128, 256 Mo |

### Formats de build pris en charge

`entry.sh` copie le build dans `/work/build/<nom>`, puis :

- `.zip`, `.tar.gz`, `.tgz`, `.tar` (si `extract` est activé) : extraction dans `/work/app`. Une archive qui contient un seul dossier racine
  (`projet-1.0/…`) est ouverte automatiquement. `{entry}` désigne alors le premier point d’entrée trouvé dans la liste du profil.
- Tout autre fichier (script, binaire statique, `.js`, `.py`, `.jar`…) : `{entry}` désigne le fichier lui-même.
- Si le programme lancé est un script sans shebang, il est exécuté avec `/bin/sh`.

Codes de sortie particuliers :

| Code | Signification |
| --- | --- |
| 121 | Échec de préparation dans `entry.sh` (archive invalide, point d’entrée introuvable, espace `/work` insuffisant), avec un message `[alpha-sandbox]` |
| 125 | Erreur du démon Docker (statut `error`) |
| 126, 127 | Programme non exécutable ou introuvable (architecture, interpréteur absent de l’image) |
| 137 | Tué par SIGKILL : mémoire épuisée ou minuterie interne |

### Ajouter un profil

1. Choisissez une image **épinglée** : `ghcr.io/mon-org/runner:1.4.2` ou `…@sha256:<digest>`, jamais `latest`. L’image doit contenir `/bin/sh` et les
   outils POSIX de base (`cp`, `head`, `wc`, `tr`, `chmod`), plus `tar` ou `unzip` (ou BusyBox) pour les archives et `timeout` pour la minuterie
   interne. Les images Alpine ou BusyBox conviennent. Les images « distroless » sans shell ne conviennent pas.
2. Ajoutez l’image à la liste blanche. Trois formes d’entrée sont possibles :
   - un dépôt (`ghcr.io/mon-org/runner`) : toutes ses versions épinglées sont autorisées ;
   - une version exacte (`ghcr.io/mon-org/runner:1.4.2` ou `…@sha256:<digest>`) : seule cette version est autorisée ;
   - un préfixe (`registry.interne/alpha/*`).

   Si `ALPHA_SANDBOX_IMAGE_ALLOWLIST` est définie, la liste doit y être modifiée par l’exploitation.
3. Dans la console, cliquez sur « Ajouter un profil » et renseignez :
   - l’identifiant ;
   - le libellé et la description, affichés aux testeurs ;
   - la commande, un argument par ligne. Variables disponibles, chacune occupant un argument entier :
     - `{input}` : chemin du build copié (`/work/build/<nom>`) ;
     - `{app}` : dossier d’extraction (`/work/app`) ;
     - `{entry}` : point d’entrée résolu ;
   - les points d’entrée possibles (chemins relatifs, le premier trouvé gagne) ;
   - l’extraction des archives ;
   - les limites.
4. Enregistrez, puis cliquez sur « Télécharger l’image » (`docker pull`, audité sous `sandbox.image_pull`) et « Tester » (self-test sur ce profil).

Exemple d’un profil Ruby (ajoutez aussi `ruby` à la liste blanche) :

```json
{
  "id": "ruby", "label": "Ruby 3.3", "description": "Lance un script Ruby. Les gems doivent être embarquées (vendor/).",
  "enabled": true, "image": "ruby:3.3-alpine", "command": ["ruby", "--disable-gems", "{entry}"],
  "entry_candidates": ["alpha_test.rb", "test.rb", "main.rb"], "extract": true,
  "timeout_s": 120, "memory_mb": 512, "cpus": 1, "pids": 128, "tmpfs_mb": 256
}
```

## Règles d’accès

`POST /api/sandbox/runs` exige :

1. un compte connecté avec la capacité `test`, dans la limite de 20 demandes par minute (sinon **401**, **403** ou **429**) ;
2. un bac à sable activé, avec un `runtime` différent de `disabled` (sinon **503**) ;
3. un profil activé (sinon **404**) dont l’image est toujours dans la liste blanche (sinon **409**) ;
4. d’être **propriétaire de la campagne**, ou **testeur dont la candidature est acceptée** sur cette campagne, mission non annulée (sinon **403**,
   ou **404** si la campagne n’est pas visible) ;
5. un fichier `campaign_build` **joint à cette campagne** et non supprimé (sinon **404**), dont l’analyse est `clean` (sinon **409**). Le statut
   `skipped` est accepté quand l’analyse n’est pas obligatoire (`files.require_scan`) et que `require_clean_scan` est désactivé. Un fichier
   `pending`, `infected` ou en `error` est refusé ;
6. un build de taille inférieure ou égale à `max_build_mb` et à la taille du tmpfs du profil (sinon **413**) ;
7. le respect du nombre de demandes en attente et du quota quotidien (**429**).

La réponse est **202** avec l’exécution au statut `queued`. Si le moteur Docker est momentanément injoignable, la demande reste en file : `GET /status`
le signale (`available: false`). Une exécution est lisible par son demandeur, le propriétaire de la campagne et les
administrateurs. Les deux premiers peuvent l’annuler. Les administrateurs peuvent l’arrêter de force.

## API

Membres (`/api/sandbox`) :

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| GET | `/status` | Activation, disponibilité du runtime, file, quota du membre |
| GET | `/profiles` | Profils activés : description, limites, points d’entrée |
| GET | `/campaigns` | Campagnes dont je suis propriétaire ou testeur accepté |
| GET | `/campaigns/:id/builds` | Builds de la campagne, avec leur éligibilité et la raison d’un refus |
| GET | `/runs?campaign_id=&status=&limit=` | Mes exécutions et celles des campagnes dont je suis propriétaire |
| POST | `/runs` | `{campaign_id, file_id, profile_id}` → 202 |
| GET | `/runs/:id` | Détail : journal, commande, limites, isolation, `can_cancel` |
| GET | `/runs/:id/logs` | Journal en texte brut, en téléchargement |
| POST | `/runs/:id/cancel` | Annulation : une exécution en attente est retirée de la file, une exécution en cours est tuée |

Administration (`/api/sandbox/admin`, administrateurs uniquement, actions auditées) :

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| GET | `/config` | Configuration, valeurs par défaut, bornes, environnement (démon, TLS, liste blanche effective) |
| PUT | `/config` | Enregistrement validé (400 avec un message par champ) |
| POST | `/test` | `{profile_id?}` : interroge le démon (version, runtimes), vérifie le runtime OCI demandé, puis lance un conteneur témoin avec l’image du profil, qui vérifie l’uid 65534, la racine en lecture seule et l’absence de réseau (seule l’interface `lo`, 1.1.1.1 injoignable) |
| POST | `/pull` | `{profile_id}` : télécharge l’image épinglée du profil |
| GET | `/runs` | Toutes les exécutions et leurs statistiques |
| POST | `/runs/:id/kill` | Arrêt forcé |

## Données, file et jobs

- `sandbox_runs` contient :
  - le demandeur, la campagne, la mission éventuelle, le build (`file_id`, nom, empreinte SHA-256) ;
  - un instantané du profil : image, commande, limites JSON, runtime ;
  - le statut : `queued`, `running`, `succeeded`, `failed`, `timeout`, `cancelled` ou `error` ;
  - le code de sortie, les horodatages, la durée, le nom du conteneur et l’erreur ;
  - le journal (256 Ko au plus : début et fin conservés, `logs_truncated`) et le journal étendu éventuel (`artifact_file_id`, 4 Mo au plus, stocké
    par le module Fichiers avec la finalité `sandbox_artifact`).

  Un déclencheur interdit de modifier une exécution terminée.
- `sandbox_daily_usage` (membre, jour UTC) compte le quota. Une exécution en `error`, ou annulée avant son démarrage, est remboursée.
- Job **`sandbox.dispatch`** (toutes les 3 s) :
  - au premier passage, il fait la récupération au démarrage : les exécutions restées `running` passent en `error`, puis les conteneurs orphelins
    de l’instance sont supprimés par étiquette ;
  - ensuite, il réserve atomiquement les exécutions en attente (ordre d’arrivée) dans la limite de `max_concurrent`, puis les lance de façon
    asynchrone. Aucune transaction ne reste ouverte pendant l’exécution.
- Job **`sandbox.cleanup`** (toutes les 30 min) :
  - rétention des journaux et des exécutions. Le journal étendu (fichier `sandbox_artifact`) suit la rétention des journaux : il est supprimé
    logiquement, puis son contenu chiffré est purgé par `files.cleanup` ;
  - expiration des demandes en attente depuis plus de 24 h (remboursées) ;
  - purge de l’historique des quotas ;
  - suppression des conteneurs et dossiers temporaires orphelins.
- Notification `sandbox.run` au demandeur à la fin de l’exécution, avec un lien vers `/sandbox/<id>`.
- Audit : `sandbox.run_requested`, `sandbox.run_cancelled`, `sandbox.config_updated`, `sandbox.self_test`, `sandbox.image_pull`.
- Données personnelles (`registerPersonalData('sandbox')`) : l’export contient les exécutions demandées et la consommation quotidienne. L’effacement
  arrête les exécutions en cours, supprime les journaux étendus, puis les exécutions et les quotas.

## Exploitation

- **Mise en service** :
  1. configurez `ALPHA_SANDBOX_DOCKER_HOST` (TLS) ;
  2. dans la console, téléchargez l’image de chaque profil ;
  3. cliquez sur « Tester » : tous les contrôles doivent être verts (`uid=65534`, `rootfs=read-only`, `network=isolated`) ;
  4. activez le module.
- **Surveillance** : l’onglet « Exécutions » de la console affiche les compteurs (en attente, en cours, terminées et en échec sur 24 h). Les
  événements sont journalisés avec les clés `sandbox.*`.
- **Incident** : passez `runtime` à `disabled` (ou décochez « Activer »). Les nouvelles demandes sont refusées immédiatement, et les exécutions en
  cours peuvent être arrêtées depuis la console.
- **Redémarrage** : aucune action n’est nécessaire. La récupération au démarrage termine proprement les exécutions interrompues.
- **Mise à jour d’image** : changez le tag ou le digest du profil, téléchargez la nouvelle image, puis testez. Les anciennes exécutions conservent
  l’image utilisée.
- **Nettoyage manuel** de l’hôte sandbox : `docker ps -a --filter label=alpha.sandbox=1`.

## Limites et feuille de route

- **Pas d’applications graphiques ni mobiles** pour l’instant : uniquement des programmes en ligne de commande (sortie texte).
- **Pas de réseau** : les builds qui ont besoin d’un service externe doivent embarquer des simulacres.
- Une seule instance applicative distribue la file (job `sandbox.dispatch`).
- L’architecture du processeur est celle de l’hôte sandbox (`amd64` ou `arm64`).
- Feuille de route :
  - **ferme d’émulateurs Android** (AVD dans des VM dédiées, installation de l’APK, captures d’écran et journal `logcat`) ;
  - **navigateur distant** (application web ou de bureau dans un conteneur Xvfb exposé en noVNC, en lecture seule ou interactif, via un proxy
    authentifié) ;
  - collecte de rapports de tests structurés (JUnit XML) ;
  - exécution sur des machines virtuelles éphémères (Firecracker) ;
  - distribution multi-instance de la file.
