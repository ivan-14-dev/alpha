# PostgreSQL : export vérifié (V4) et plan de migration (V5)

En V4, Alpha **continue de tourner sur SQLite** (`node:sqlite`, `DatabaseSync`). La V4 livre en revanche un chemin
de migration complet et testé vers PostgreSQL. Il comprend :

- un **convertisseur de schéma générique**, qui lit n’importe quelle base SQLite et produit le DDL PostgreSQL ;
- un **outil d’export** qui copie toutes les lignes, puis **vérifie** le résultat : comptages, sommes de contrôle,
  clés étrangères, séquences et présence des objets ;
- des **tests** exécutés contre un vrai PostgreSQL 16, en local avec Docker comme en CI ;
- le **plan V5** pour passer le runtime en asynchrone et basculer vers PostgreSQL.

## Fichiers

| Rôle | Fichiers |
| --- | --- |
| Analyse SQL SQLite (tokenizer, `CREATE TABLE/INDEX/TRIGGER/VIEW`) | `server/pg/sql.ts` |
| Traduction des expressions (types, fonctions, `DEFAULT`, `CHECK`) | `server/pg/translate.ts` |
| Traduction des déclencheurs (plpgsql) | `server/pg/triggers.ts` |
| Convertisseur : introspection et DDL | `server/pg/convert.ts` (`convertSqliteSchema()`, `renderDdl()`) |
| Copie et vérification | `server/pg/copy.ts` (`exportToPostgres()`, `verifyExport()`, `formatReport()`) |
| Outil en ligne de commande | `scripts/export-postgres.ts` (`npm run db:export:postgres`) |
| Tests | `tests/postgres/convert.test.ts` (sans PostgreSQL), `tests/postgres/export.test.ts` (PostgreSQL 16) |

## Pourquoi le runtime reste sur SQLite en V4

- **Toute l’API d’accès aux données est synchrone.** `server/db.ts` expose `all()`, `one()`, `run()` et
  `transaction(fn)`, et `transaction()` refuse explicitement une fonction qui renvoie une promesse. Plus de
  100 fichiers serveur (modules, jobs, hooks de notification, `onCommit`) reposent sur cette garantie : une
  transaction ne contient aucun `await`, donc aucune requête d’une autre requête HTTP ne peut s’y intercaler. Le
  pilote `pg` est asynchrone par nature. Le brancher demanderait de réécrire chaque appel et chaque transaction,
  et de revoir tous les invariants qui supposent l’absence d’entrelacement (registre comptable, compteurs de
  factures, limites de débit, machines à états).
- **Une seule instance suffit aujourd’hui.** SQLite en mode WAL sert sans difficulté la charge visée, avec des
  lectures concurrentes, un écrivain unique et `busy_timeout`. Sauvegarde, restauration et supervision sont
  outillées par `npm run backup|restore` (voir `docs/deployment.md` et `docs/operations.md`).
- **Le risque est maîtrisé.** Changer de moteur et de modèle d’exécution en même temps que les modules V4
  (paiements, conformité, confiance, vie privée) cumulerait deux grands chantiers. La V4 prépare donc la bascule :
  schéma traduisible sans perte, données vérifiables et procédure répétée. La V5 l’exécute.

## Ce que l’export apporte dès aujourd’hui

- **Réplique d’analyse.** Une copie PostgreSQL fidèle sur laquelle brancher un outil de BI ou des requêtes lourdes,
  sans charger la base de production. Voir aussi [Sécurité et données personnelles](#sécurité-et-données-personnelles).
- **Répétition de migration.** Chaque export rejoue la conversion sur les données réelles. Il fait remonter les
  valeurs que PostgreSQL refuserait (types incohérents, caractères NUL, `CHECK` mal traduit) bien avant le jour J.
- **Sauvegarde vérifiée dans un second format.** Le rapport prouve que chaque table a les mêmes lignes au bit près
  des deux côtés.
- **Garde-fou de schéma.** Le test `tests/postgres/convert.test.ts` échoue dès qu’une nouvelle migration utilise
  une construction SQLite que le convertisseur ne sait pas traduire.

## Utilisation

### Commandes

```bash
# Export complet + vérification (la connexion est lue dans ALPHA_PG_URL)
export ALPHA_PG_URL='postgres://alpha:<mot de passe>@localhost:5432/alpha'
npm run db:export:postgres -- --sqlite data/alpha.sqlite --schema alpha --drop

# Rapport JSON en plus du rapport texte
npm run db:export:postgres -- --drop --report data/export-report.json

# Vérifier un export existant sans rien écrire (par exemple après une copie manuelle)
npm run db:export:postgres -- --verify-only

# Générer seulement le DDL PostgreSQL, sans connexion
npm run db:export:postgres -- --ddl-only data/alpha-postgres.sql
npm run db:export:postgres -- --ddl-only - | less
```

Préférez la variable `ALPHA_PG_URL` à `--pg` : une URL passée en argument est visible dans `ps` et dans
l’historique du shell. Le mot de passe n’est jamais affiché, ni dans le rapport, ni dans les erreurs, ni dans le
JSON : il est remplacé par `****`. Pour TLS, ajoutez `?sslmode=require` à l’URL.

### Options

| Option | Effet |
| --- | --- |
| `--sqlite <chemin>` | Base source, ouverte **en lecture seule**. Défaut : `$DATABASE_PATH`, sinon `data/alpha.sqlite`. |
| `--pg <url>` | PostgreSQL cible. Défaut : `$ALPHA_PG_URL`. |
| `--schema <nom>` | Schéma cible (défaut `alpha`). Les schémas `public`, `pg_*` et `information_schema` sont refusés. |
| `--drop` | Supprime puis recrée le schéma cible. Sans cette option, un schéma non vide n’est jamais écrasé. |
| `--batch <n>` | Lignes par `INSERT` multi-lignes (défaut 1000, entre 1 et 100 000). |
| `--ddl-only <fichier>` | Écrit le DDL autonome (`-` pour la sortie standard) puis s’arrête, sans connexion. |
| `--verify-only` | Compare la base SQLite avec un export existant, sans écrire (incompatible avec `--drop`). |
| `--no-rowid` | N’ajoute pas de colonne `rowid` aux tables sans `INTEGER PRIMARY KEY` (voir plus bas). |
| `--report <fichier>` | Écrit aussi le rapport au format JSON. |

### Codes de sortie

| Code | Signification |
| --- | --- |
| `0` | Export et vérification réussis : données identiques et contraintes valides. |
| `1` | Export terminé, mais avec des erreurs ou des écarts : objet non créé, somme de contrôle différente, clé étrangère invalide… |
| `2` | Usage incorrect, base SQLite introuvable, connexion impossible, schéma existant sans `--drop` ou erreur fatale (tout est annulé). |

### Rapport

La progression s’affiche sur la sortie d’erreur. Le rapport final, en français, s’affiche sur la sortie standard :

```text
Export SQLite → PostgreSQL (schéma "alpha")
  Source : data/alpha.sqlite (SQLite 3.x)
  Cible  : postgres://alpha:****@postgres:5432/alpha
  Schéma : 79 tables, 266 CHECK, 112 index, 134 clés étrangères, 9 déclencheurs, 0 vues
  Copie  : 94 ligne(s) en 1.3 s, 79 séquence(s) repositionnée(s)

Vérification (0.4 s) :
  ✔ users                    6         ligne(s)  md5 d56674546ce6
  …
  ✔ 50 table(s) vide(s) des deux côtés
  Clés étrangères validées : 134/134
  Objets présents : tables 79/79, CHECK 266/266, index 112/112, déclencheurs 12/12, vues 0/0
  Séquences d’identité en avance sur max(id) : 79/79

Résultat : OK — données identiques et contraintes valides.
```

Chaque écart est détaillé : table, comptages, sommes de contrôle et première clé primaire divergente. La liste
reprend aussi les objets manquants, les clés étrangères invalides, les avertissements du convertisseur et les
violations de clés étrangères déjà présentes dans la base SQLite source (`PRAGMA foreign_key_check`).

### Avec Docker Compose

Le profil `postgres` de `docker-compose.yml` fournit un PostgreSQL 16 interne. L’image de l’application contient
déjà `pg`, `tsx` et le script. La procédure est décrite dans `docs/deployment.md` (§ 13) :

```bash
docker compose --profile postgres up -d postgres
docker compose run --rm --no-deps \
  -e ALPHA_PG_URL="postgres://alpha:<mot de passe>@postgres:5432/alpha" app npm run db:export:postgres -- --drop
```

L’export lit un **instantané cohérent** : une seule transaction de lecture SQLite couvre la copie et la
vérification. L’application peut donc continuer à tourner. Les écritures faites pendant l’export ne sont pas
copiées, et le fichier WAL grossit tant que l’export dure, car le checkpoint attend la fin de la lecture.

## Fonctionnement

### Conversion (`server/pg/convert.ts`)

Le convertisseur **n’a aucune table codée en dur**. Il interroge `sqlite_schema` et les pragmas `table_xinfo`,
`foreign_key_list`, `index_list` et `index_xinfo`. Il analyse aussi le SQL stocké pour retrouver ce que les pragmas
ne donnent pas : `CHECK`, clause `WHERE` des index partiels, expressions d’index, corps des déclencheurs et des vues.

| SQLite | PostgreSQL |
| --- | --- |
| `INTEGER PRIMARY KEY` (alias du rowid, avec ou sans `AUTOINCREMENT`) | `bigint GENERATED BY DEFAULT AS IDENTITY`, séquence repositionnée à `max(max(id), sqlite_sequence) + 1` |
| affinité `INTEGER` (dont les booléens 0/1) | `bigint`, avec le `CHECK (x IN (0,1))` d’origine conservé |
| affinité `TEXT` (et `DATE`, `TIME`, `JSON`, `UUID`) | `text COLLATE "C"`, pour l’ordre binaire comme SQLite |
| affinité `REAL` | `double precision` |
| `BLOB` | `bytea` |
| `NUMERIC`, `DECIMAL` | `numeric` |
| Colonne générée `GENERATED ALWAYS AS (…) STORED/VIRTUAL` | `GENERATED ALWAYS AS (…) STORED` |
| `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, utilisé 88 fois dans le schéma | `to_char((statement_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, même format ISO 8601 |
| `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME` | `to_char(…)` au format texte SQLite (`YYYY-MM-DD HH24:MI:SS`…) |
| `CHECK` : `length`, `substr`, `trim`, `ifnull`, `instr`, `hex`, `typeof`, `iif`, `json_valid`, `json_type`, `json_array_length`, `strftime`, `!=`, `GLOB`, `LIKE`… | Équivalents PostgreSQL : `length` (`octet_length` pour un BLOB), `substr`, `btrim`, `coalesce`, `strpos`, `encode(…, 'hex')`, `CASE`, `<>`, `~` (expression régulière ancrée), `ILIKE`… Les fonctions JSON passent par des fonctions d’aide `sqlite_json_*` créées dans le schéma cible. |
| `UNIQUE`, clés primaires composites, `WITHOUT ROWID` | Contraintes `UNIQUE` / `PRIMARY KEY` équivalentes |
| Clés étrangères avec `ON DELETE/UPDATE CASCADE/SET NULL/RESTRICT…` | `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … DEFERRABLE` après la création de **toutes** les tables, ce qui couvre les cycles et l’ordre de chargement |
| Index, index uniques, index partiels (`WHERE`), index d’expression, `COLLATE NOCASE` | `CREATE [UNIQUE] INDEX … [WHERE …]`. `NOCASE` dans un index devient `lower(col)`. |
| Déclencheurs d’immuabilité (`BEFORE UPDATE/DELETE … SELECT RAISE(ABORT, '…')`) | Fonction plpgsql qui lève `RAISE EXCEPTION … USING ERRCODE = '23000'`. Un garde sur `DELETE` reçoit aussi un garde `BEFORE TRUNCATE`. |
| Déclencheurs « garde » avec `WHEN` (y compris des sous-requêtes) | Même fonction, la condition `WHEN` étant reportée dans le corps si PostgreSQL ne l’accepte pas dans `WHEN` |
| Déclencheurs « touch » (`UPDATE t SET updated_at = … WHERE id = NEW.id`) | Déclencheur `BEFORE UPDATE` qui affecte `NEW.updated_at` |
| Autres déclencheurs simples (`INSERT/UPDATE/DELETE` dans le corps) | Traduction instruction par instruction en plpgsql, **avec un avertissement** pour relecture |
| Vues | `CREATE VIEW` traduit, créé après les tables, dans l’ordre des dépendances |
| Tables virtuelles (FTS5…) | Refusées et signalées. Leurs tables internes ne sont pas exportées. |

Tout ce qui ne peut pas être traduit est listé dans `warnings` (et dans `unsupported` avec le SQL d’origine). Le DDL
contient alors un commentaire à la place de l’objet. Le résultat de `convertSqliteSchema()` est
`{ ddl, warnings, tables, indexes, foreignKeys, triggers, views, helpers, unsupported }`.

### Couverture du schéma Alpha actuel

Mesurée sur `server/schema.sql` et les migrations 002 à 013 :

| Objet | Nombre | Résultat |
| --- | --- | --- |
| Tables | 79 | toutes converties, dont 79 colonnes d’identité (clé entière ou `rowid`) |
| `CHECK` | 266 | tous traduits ; fonctions d’aide utilisées : `sqlite_json_valid`, `sqlite_json_type`, `sqlite_json_array_length` |
| Index | 112 | tous traduits, dont les index partiels (par exemple `appeals_one_pending`) |
| Clés étrangères | 134 | toutes créées puis validées |
| Déclencheurs | 9 | 7 gardes d’immuabilité (registre, factures, consentements), plus le garde de statut terminal de `sandbox_runs` et la limite d’appels par sanction ; 3 gardes `TRUNCATE` ajoutés, soit 12 déclencheurs PostgreSQL |
| Vues | 0 | — |
| **Avertissements** | **0** | aucun objet non pris en charge |

### Colonne `rowid`

Plusieurs requêtes s’appuient sur le `rowid` implicite de SQLite :

- départage des tris (`ORDER BY created_at DESC, rowid DESC`) dans `messages`, `notifications`, `audit_events` et
  `email_outbox` ;
- curseur du job `compliance.invoices` sur `ledger_journals`.

Pour ne pas perdre cette information, chaque table qui n’a pas de `INTEGER PRIMARY KEY` reçoit une colonne
`rowid bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE`, placée en dernière position et remplie avec le rowid
d’origine. Les tables `WITHOUT ROWID` n’en reçoivent pas. `--no-rowid` désactive ce comportement, par exemple pour
une réplique d’analyse ; la vérification ordonne alors les lignes par clé primaire.

### Copie (`server/pg/copy.ts`)

Tout se passe dans **une seule transaction PostgreSQL**. En cas d’erreur fatale, rien n’est laissé dans la base.

1. Création du schéma (refusée s’il existe et n’est pas vide, sauf avec `--drop`), puis des fonctions d’aide, puis
   des tables sans `CHECK` ni clé étrangère.
2. Copie des lignes table par table, par `INSERT` multi-lignes paramétrés. Les entiers sont lus en `BigInt`, ce
   qui évite toute perte au-delà de 2^53. Les BLOB deviennent `bytea` et les réels gardent leur valeur exacte.
3. Ajout des `CHECK`, des index et des clés étrangères (`NOT VALID`). Cet ordre est plus rapide, et chaque
   contrainte est contrôlée sur les données réelles au moment de sa création.
4. Repositionnement des séquences d’identité.
5. Création des déclencheurs **en dernier** : ils ne se déclenchent jamais pendant le chargement. Viennent ensuite
   les vues.
6. `COMMIT`, puis `ALTER TABLE … VALIDATE CONSTRAINT` pour chaque clé étrangère.

Les étapes 3 à 5 sont isolées par des `SAVEPOINT`. Un objet refusé est consigné dans le rapport avec le message de
PostgreSQL (code de sortie 1), sans annuler le reste.

### Vérification

La vérification se fait dans une transaction PostgreSQL `REPEATABLE READ READ ONLY`, face au même instantané SQLite :

- **Comptage** des lignes, table par table.
- **Somme de contrôle** : md5 de la suite des lignes ordonnées par clé primaire (ou `rowid`), chaque ligne étant
  sérialisée en JSON canonique des deux côtés. Les entiers sont écrits en décimal exact, les réels au format
  aller-retour, les BLOB en hexadécimal. L’ordre est binaire : `COLLATE BINARY` côté SQLite, `COLLATE "C"`
  côté PostgreSQL.
- **Clés étrangères** validées côté PostgreSQL, et `PRAGMA foreign_key_check` côté SQLite.
- **Objets** : présence de chaque table, `CHECK`, index, déclencheur et vue attendus.
- **Séquences** : la prochaine valeur de chaque identité est strictement supérieure à `max(id)`.

## Tests et CI

```bash
npm run test:postgres
# équivaut à : npx tsx --test --test-concurrency=1 tests/postgres/*.test.ts
```

- `tests/postgres/convert.test.ts` n’a pas besoin de PostgreSQL. Il couvre :
  - les affinités de types, la traduction de `GLOB` et de `strftime`, le masquage des URL et la validation des noms
    de schéma ;
  - un schéma « fourre-tout » : types, valeurs par défaut, `CHECK`, index partiels et d’expression, clés
    étrangères, déclencheurs et vues ;
  - le **schéma Alpha complet**, qui doit se convertir sans aucun avertissement.
- `tests/postgres/export.test.ts` a besoin de PostgreSQL 16 :
  - il utilise `ALPHA_PG_URL` si la variable est définie, sinon il lance `postgres:16-alpine` avec Docker sur un
    port aléatoire. La suite est ignorée (`skip`) si ni l’un ni l’autre n’est disponible ;
  - il construit une base avec **toutes** les migrations et les données de démonstration (`server/seed.ts`), puis
    ajoute des cas limites : Unicode, retours à la ligne, identifiants sensibles à la casse, `NULL`, JSON, montants
    du registre à ±(2^53+1), taux de change réels, factures, consentements, fichiers, sanctions et appels ;
  - il exporte, vérifie, puis contrôle le comportement dans PostgreSQL : `CHECK` violé (23514), unicité et index
    unique partiel (23505), `NOT NULL` (23502), clé étrangère (23503), déclencheurs d’immuabilité sur `UPDATE`,
    `DELETE` et `TRUNCATE` (23000), statut terminal du bac à sable, limite d’appels, valeur par défaut ISO et ordre
    binaire ;
  - il vérifie que toute altération est détectée (valeur modifiée, ligne supprimée) et qu’un schéma existant n’est
    jamais écrasé sans `--drop` ;
  - il teste l’outil en ligne de commande : codes de sortie, `--verify-only`, `--ddl-only`, et l’absence du mot de
    passe dans la sortie.
- **CI** : le job `postgres` de `.github/workflows/ci.yml` démarre un service `postgres:16-alpine`, définit
  `ALPHA_PG_URL` et lance `npm run test:postgres`. Les tests créent puis suppriment leurs propres schémas, avec un suffixe
  aléatoire (`alpha_it_…`, `kit_…`, `cli_…`, `ddl_…`). Ils n’ont pas besoin de droits superutilisateur.

## Limites connues

- **`LIKE` devient `ILIKE`.** SQLite ignore la casse pour l’ASCII seulement, PostgreSQL pour tout Unicode. Un
  `CHECK` peut donc accepter quelques valeurs de plus côté PostgreSQL.
- **`COLLATE NOCASE` sur une colonne** devient `COLLATE "C"`, avec un avertissement : unicité et égalité deviennent
  sensibles à la casse. Dans un index, `NOCASE` devient `lower(col)`. Le schéma Alpha n’en utilise pas.
- **Déclencheurs génériques** : traduits instruction par instruction, ils doivent être relus. Ceux qui ne
  correspondent à aucun motif reconnu sont signalés avec leur SQL d’origine.
- **Typage dynamique** : PostgreSQL refuse une valeur dont le type ne correspond pas à la colonne (texte dans une
  colonne `INTEGER`, clé primaire `NULL`, caractère NUL dans un texte). La copie échoue alors avec la table et le
  message : c’est voulu, ces données doivent être corrigées dans SQLite avant la bascule. Dans une colonne
  d’affinité `NUMERIC` exportée en `text`, des valeurs de types mélangés peuvent changer d’ordre et provoquer un
  écart de somme de contrôle.
- **Horodatage** : `statement_timestamp()` remplace le `'now'` de SQLite. Les deux valent l’heure de l’instruction.
  La précision reste la milliseconde, au même format texte.
- **Identité** : une colonne d’identité refuse un `NULL` explicite à l’insertion, alors que SQLite attribue alors un
  rowid. Le code applicatif d’Alpha n’insère jamais de `NULL` explicite dans ces colonnes. La colonne `rowid`
  ajoutée apparaît aussi dans les `SELECT *`.
- **JSON** : en dehors d’un `CHECK`, les fonctions d’aide renvoient `NULL` sur un JSON invalide, alors que SQLite
  lève une erreur. `randomblob()` est émulé à partir de `gen_random_uuid()`.
- **Tables virtuelles** (FTS5…) : elles ne sont pas exportées. Il faudra les remplacer par `tsvector` et un index
  GIN.
- **Version** : PostgreSQL 13 ou plus récent est requis (`gen_random_uuid()` intégré). Les tests tournent sur la
  version 16.
- **Volume** : l’export utilise des `INSERT` par lots, pas `COPY`. Il convient aux volumes actuels d’Alpha. Pour des
  dizaines de millions de lignes, passer à `COPY FROM STDIN` (pg-copy-streams) et mesurer la durée lors de la répétition.

## Sécurité et données personnelles

L’export est une **copie intégrale** : comptes, empreintes de mots de passe, sessions (hachées), consentements,
journaux d’audit, données KYC et secrets d’intégration (chiffrés). La base PostgreSQL cible doit être protégée comme
la base de production : réseau interne, TLS, sauvegardes chiffrées et accès nominatifs.

Pour une réplique d’analyse, créez un rôle en lecture seule limité à des vues sans données personnelles. Les
suppressions RGPD faites dans SQLite après l’export ne s’appliquent pas à la copie : réexportez avec `--drop` ou
supprimez les anciennes copies (voir `docs/v4/privacy.md`).

## Plan V5 : runtime asynchrone sur PostgreSQL

L’objectif est de basculer sans « big bang » : le code devient d’abord asynchrone en restant sur SQLite, puis on
change de moteur par configuration.

### 1. Abstraction `Db` asynchrone

Une interface unique, avec deux pilotes interchangeables :

```ts
export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  one<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number; lastId?: bigint }>;
  transaction<T>(work: () => Promise<T>, options?: { isolation?: 'serializable' | 'read committed' }): Promise<T>;
  onCommit(work: () => void | Promise<void>): void;
}
```

- `SqliteDb` enveloppe `DatabaseSync` : les promesses sont déjà résolues, et une file d’attente sérialise les
  transactions pour conserver l’isolation actuelle.
- `PgDb` repose sur `pg.Pool`. Il convertit les paramètres `?` en `$1…$n`, sauf pour les requêtes écrites
  directement dans ce format, et lit les `bigint` en `BigInt` ou en `number` selon la colonne.
- Le pilote est choisi selon `DATABASE_URL` : `postgres://…` donne PostgreSQL, sinon on garde `DATABASE_PATH`.

### 2. Conversion progressive des modules

- Ajouter `await` aux appels module par module, en commençant par les feuilles (lecture seule, administration),
  puis le cœur (comptes, paiements, registre). Les hooks (`onNotification`, événements de domaine) et les jobs
  deviennent `async`.
- Chaque module converti tourne d’abord sur `SqliteDb`, ce qui permet de garder la suite de tests existante.
- Un lint interdit d’importer `server/db.ts` (synchrone) dans un module déjà converti.

### 3. Transactions via `AsyncLocalStorage`

- `transaction()` ouvre une connexion dédiée (`pool.connect()`), `BEGIN`, et la range dans un `AsyncLocalStorage`.
  Tous les `all/one/run` appelés dans ce contexte, y compris dans les fonctions imbriquées, utilisent cette
  connexion sans la passer en paramètre.
- Les appels imbriqués créent des `SAVEPOINT`, comme aujourd’hui. `onCommit` s’exécute après le `COMMIT` le plus
  externe.
- Les invariants qui reposaient sur l’absence d’entrelacement sont rendus explicites :
  - `SELECT … FOR UPDATE` sur les lignes lues puis modifiées (soldes, compteurs de factures, machines à états) ;
  - `SERIALIZABLE` avec nouvelle tentative automatique (SQLSTATE 40001 / 40P01) pour le registre ;
  - contraintes `UNIQUE` pour l’idempotence (déjà en place).
- Règle conservée : pas d’appel HTTP ni de Docker dans une transaction. Un délai `idle_in_transaction_session_timeout`
  la fait respecter.

### 4. Migrations double dialecte

- `schema_migrations` est conservée. Chaque migration future est écrite en deux fichiers
  (`NNN-nom.sqlite.sql` et `NNN-nom.pg.sql`), ou en SQL commun quand c’est possible.
- La base PostgreSQL de départ est **générée par le convertisseur** à partir du schéma SQLite final (`--ddl-only`),
  puis figée comme migration `000-baseline.pg.sql`.
- Un test de CI applique les deux séries de migrations et compare les schémas obtenus (tables, colonnes, contraintes,
  index) au résultat du convertisseur.
- Nettoyages de schéma prévus côté PostgreSQL, une fois le code prêt :
  - remplacer les tris par `rowid` par des colonnes explicites (`seq bigint GENERATED ALWAYS AS IDENTITY`), puis
    retirer `rowid` ;
  - passer aux types natifs (`timestamptz`, `boolean`, `jsonb`), ce qui demande d’adapter le code ;
  - utiliser la recherche plein texte (`tsvector` et un index GIN).

### 5. Procédure de bascule

1. **Répétition** : export avec `--drop` et vérification sur une copie de production, suite de tests complète contre
   PostgreSQL et test de charge. Noter la durée de l’export pour dimensionner la fenêtre de maintenance.
2. **Gel** : annonce, puis mode maintenance (écritures refusées, jobs arrêtés avec `stopJobs`, flux SSE fermés).
   Sauvegarde finale de SQLite (`npm run backup`).
3. **Export final** : `npm run db:export:postgres -- --drop --report bascule.json`. Le code de sortie doit être `0`
   et le rapport conservé.
4. **Vérification** : `--verify-only`, puis contrôles fonctionnels : soldes du registre, dernières factures,
   connexion d’un compte de test.
5. **Bascule** : définir `DATABASE_URL=postgres://…`, redémarrer l’application, puis lever la maintenance.
6. **Retour arrière** : tant qu’aucune écriture n’a été acceptée sur PostgreSQL, il suffit de retirer
   `DATABASE_URL` pour revenir sur SQLite. Après réouverture, le retour arrière passerait par un export inverse
   PostgreSQL vers SQLite, à outiller en V5. Gardez donc une période d’observation courte et surveillée.

## Passage à plusieurs instances

PostgreSQL permet de faire tourner plusieurs instances de l’application derrière un répartiteur de charge. Cela
impose quelques changements :

- **Temps réel (SSE).** Les connexions sont aujourd’hui gardées en mémoire (`server/realtime/sse.ts`). Un événement
  émis sur une instance doit atteindre les clients connectés aux autres. Deux options :
  - `LISTEN/NOTIFY` de PostgreSQL : sans nouvelle dépendance, avec une charge utile de 8 Ko maximum (envoyer des
    identifiants plutôt que des contenus) ;
  - Redis Pub/Sub, si le volume augmente.

  L’instance qui reçoit l’événement le relaie à ses propres connexions. L’affinité de session n’est pas nécessaire.
- **Jobs planifiés.** `server/platform/jobs.ts` évite seulement le chevauchement au sein d’un processus. Avec
  plusieurs instances, chaque exécution prend un verrou `pg_try_advisory_lock(hashtext('job:<nom>'))` ; une instance
  qui n’obtient pas le verrou passe son tour. Les files de travail (e-mails, push, webhooks) prennent leurs lignes
  avec `SELECT … FOR UPDATE SKIP LOCKED`, ce qui permet de répartir le travail sans doublon.
- **État partagé.** Sessions et limites de débit sont déjà stockées en base (`sessions`, `rate_limit_buckets`) :
  elles deviennent partagées automatiquement. Les caches et registres en mémoire (hooks, configuration) restent
  locaux, car ils sont déterministes.
- **Fichiers.** Les fichiers déposés sont sur le disque local (`FILES_DIR`). Il faut un volume partagé ou, mieux, un
  stockage objet compatible S3.
- **Bac à sable.** Les exécutions Docker restent attachées à l’hôte qui les lance. Le verrou de job et le statut en
  base garantissent qu’une seule instance pilote chaque exécution.
- **Connexions.** `pg.Pool` est dimensionné par instance (par exemple 10). PgBouncer en mode transaction peut se
  placer devant PostgreSQL. Attention : il ne conserve pas les verrous consultatifs de session, donc préférez
  `pg_try_advisory_xact_lock` dans une transaction.
