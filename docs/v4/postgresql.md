# PostgreSQL (V4)

En V4, le runtime d’Alpha reste sur SQLite (`node:sqlite`, API synchrone). La V4 livre un **export SQLite →
PostgreSQL vérifié** et le plan de migration V5. La documentation complète se trouve dans
[`docs/postgresql.md`](../postgresql.md).

## En bref

| Élément | Où |
| --- | --- |
| Convertisseur de schéma générique (introspection SQLite → DDL PostgreSQL) | `server/pg/convert.ts`, `server/pg/sql.ts`, `server/pg/translate.ts`, `server/pg/triggers.ts` |
| Copie et vérification (comptages, md5 par table, clés étrangères, séquences) | `server/pg/copy.ts` |
| Outil en ligne de commande | `npm run db:export:postgres -- --help` (`scripts/export-postgres.ts`) |
| Tests (PostgreSQL 16 via `ALPHA_PG_URL` ou Docker) | `npm run test:postgres` (`tests/postgres/*.test.ts`) |
| Déploiement (profil Compose `postgres`) | `docs/deployment.md`, § 13 |

```bash
ALPHA_PG_URL='postgres://alpha:<mot de passe>@localhost:5432/alpha' npm run db:export:postgres -- --drop
```

Code de sortie : `0` si les données sont identiques et les contraintes valides, `1` en cas d’écart, `2` en cas
d’erreur d’usage ou de connexion.

Sur le schéma actuel (79 tables, 266 `CHECK`, 112 index, 134 clés étrangères, 9 déclencheurs), la conversion ne
produit **aucun avertissement**.
