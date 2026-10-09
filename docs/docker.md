# Docker / GHCR

Docker Compose is the canonical product deployment for NJU Info Hub. GitHub Actions owns software CI/GHCR publishing; the Pages content workflow remains manually disabled while public deployment acceptance is pending. Publishing a software image does not activate a public information service.

## Image

Images are published to:

```text
ghcr.io/zhongyangchuwu/nju-info-hub
```

The container workflow publishes immutable revision tags in the form `sha-<short-sha>`. A Git tag such as `v1.2.3` also publishes the matching version tag. The workflow deliberately does not publish an implicit `latest` tag.

The image uses Node 26 and runs the compiled release artifact. pnpm, TypeScript, esbuild, `tsx`, workspace source packages, and workspace metadata exist only in the builder stage and are absent from the final runtime image. It runs as the unprivileged `node` user. The Dockerfile supports Linux amd64 and arm64; GHCR publishing produces both architectures under the same tag.

## Runtime model

One image exposes a stable `nju-info` entrypoint:

- `serve` (default): read-only HTTP API on port 3000;
- `validate`: validate the selected instance configuration;
- `collect`: run one configured public collection;
- `schedule`: run one collection at startup, then collect on the configured cron/timezone;
- `export`: generate static syndication output;
- `source`: access lower-level public source discovery/fetch/ingest commands;

All commands use the same image and local SQLite volume. The scheduler owns recurring collection; the optional HTTP API remains a read-only consumer.

SQLite remains local to the active runtime. The API opens an existing current-schema database read-only and does not create or migrate state.

## Instance configuration

Current instance files use schema version 4:

```json
{
  "schemaVersion": 4,
  "publication": {
    "publicBaseUrl": "https://example.invalid/",
    "sources": ["nju-example"],
    "sets": []
  },
  "collection": {
    "schedule": "17 */2 * * *",
    "timeZone": "UTC",
    "sources": [
      { "id": "nju-example", "recentLimit": 10 }
    ]
  }
}
```

Collection and publication policy are intentionally separate. `collection.sources[].recentLimit` caps the initial bootstrap and later controls how many recent known items are refreshed for revision detection; incremental runs scan until the first page containing any known item plus one observation-only lookahead page, then enrich unseen items only through the overlap page. No known overlap in 10 search pages fails that source before item observation or detail acquisition; the 100-page hard cap still applies. Full-detail acquisition is best-effort and does not refill from older items. `publication.sources` controls which persisted sources are exposed. SQLite keeps the complete history, while Feed publication exposes the shared producer recent window (currently 100 entries per source). Published sources must also be collected by the same instance.

Collection cadence is runtime-neutral. The same schedule metadata is consumed by the resident Docker scheduler and checked against the static GitHub Actions cron for the official reference deployment.

`timeZone` must be a valid IANA timezone. The current instance contract is schema v4; older pre-release shapes are rejected instead of normalized at runtime.

## Canonical Compose deployment

For the normal repository checkout, copy the example environment and start Compose:

```bash
cp .env.example .env
docker compose up -d
```

The example pins a known-good immutable multi-arch image. To upgrade, replace `NJU_INFO_IMAGE` in `.env` with a newer `sha-*` tag, version tag, or digest. Mutable `latest` is intentionally rejected for the official GHCR repository.

For local development:

```bash
docker build -t nju-info-hub:local .
export NJU_INFO_IMAGE=nju-info-hub:local
```

Start the canonical instance:

```bash
docker compose up -d
```

The default Compose services are:

- `scheduler`: performs an initial collection, then follows the instance cron/timezone;
- `api`: waits for the first successful collection readiness marker, then serves the read-only API.

Both share the named `nju-info-data` volume. The API is bound to `127.0.0.1:3000` by default:

```text
http://127.0.0.1:3000/v1/health
```

Override only the host port when needed:

```bash
NJU_INFO_PORT=3100 docker compose up -d
```

A fresh volume does not need a manual database bootstrap. The scheduler creates/updates state through the normal collector. After its first usable run (at least one configured source succeeds) it writes a readiness marker into the data volume; the API does not start serving until that marker exists.

The API wait timeout defaults to 900 seconds and can be changed with `NJU_INFO_READY_TIMEOUT_SECONDS`.

### Manual collection

The one-shot collector remains available for explicit refresh/debugging:

```bash
docker compose --profile maintenance run --rm collect
```

It is not the normal scheduling mechanism.

### Backup and restore

Create and verify a durable snapshot while the service is running:

```bash
docker compose --profile maintenance run --rm maintenance
docker compose --profile maintenance run --rm maintenance verify-backup /backup/state.tar.gz
```

Snapshots are written under `NJU_INFO_BACKUP_DIR` (default `./backups`). Backup uses SQLite's backup API and is safe while the scheduler/API are running.

Restore is deliberately an offline maintenance operation. Stop the scheduler and API first so no process keeps the old SQLite file open or writes concurrently, restore the snapshot, then restart:

```bash
docker compose down
docker compose --profile maintenance run --rm maintenance restore /backup/state.tar.gz
docker compose up -d
```

Do not restore into the shared data volume while the resident services are running.

Restore verifies the archive, database integrity and checksum before replacing state. A verified snapshot also records `schema_version`; integrity verification is not proof that every older image can read that schema. Keep a verified pre-upgrade snapshot before changing image versions, and do not overwrite it with the post-upgrade backup.

## Custom instance config

From this repository, Compose defaults to `instances/official.json`. Override it without changing the Compose file:

```bash
NJU_INFO_CONFIG_FILE=/absolute/path/to/instance.json \
  docker compose up -d
```

Inside scheduler/collector containers the file is mounted as `/config/instance.json`.

The deployment contract is:

```text
immutable image + instance config + persistent data volume
```

not a source-code fork.

## Stop and upgrade

Stop services without deleting state:

```bash
docker compose down
```

The named volume remains.

Upgrade:

1. create and verify a separately named pre-upgrade snapshot with the currently running image;
2. stop scheduler/API so old readers do not race a schema migration;
3. choose a new immutable GHCR revision/version tag and update `NJU_INFO_IMAGE`;
4. pull and run the new writer once to migrate/collect, then recreate resident services.

```bash
docker compose --profile maintenance run --rm maintenance backup /backup/pre-upgrade.tar.gz
docker compose --profile maintenance run --rm maintenance verify-backup /backup/pre-upgrade.tar.gz
docker compose down
# set NJU_INFO_IMAGE to the new immutable reference
docker compose pull
docker compose --profile maintenance run --rm collect
docker compose up -d
```

The scheduler performs collection using the new image while the SQLite volume is preserved.

The current reader requires schema v7; the writer migrates v6 before read-only delivery starts. A downgrade is **not** just changing the image tag: stop resident services, select the previous immutable image, restore its verified pre-upgrade snapshot, and only then start the old reader/scheduler. A v6 reader cannot open a v7 database. Restoring the pre-upgrade snapshot loses later writes unless they are preserved separately; retain both snapshots before deciding to roll back.

Removing the named volume is a destructive state reset and is intentionally not part of normal stop/upgrade flow.

## Health and readiness

The image healthcheck probes the API's existing `/v1/health` endpoint. The scheduler service disables that HTTP healthcheck because it does not expose HTTP.

Compose readiness is state-based:

1. scheduler validates config;
2. startup collection succeeds;
3. scheduler writes `/data/.collection-ready`;
4. API proceeds to open the existing database read-only;
5. HTTP healthcheck becomes healthy.

A failure from one source is logged without blocking later sources in the same run; that source keeps its previously persisted entries until a later run succeeds. If every configured source fails, the run fails and the scheduler remains alive for the next configured run. On a fresh volume it does not publish readiness until at least one source succeeds.

Health is HTTP/database-reader liveness, not per-source collection health. A retained readiness marker permits serving previously collected data while a later source fails; inspect collection status and clocks for collection progress. Do not interpret a low-cadence source having no new article as an outage.

## Collection logs and status

```bash
docker compose logs --since 1h scheduler
docker compose exec -T api nju-info status
curl http://127.0.0.1:3000/v1/collection/status
curl 'http://127.0.0.1:3000/v1/collection/runs?limit=20'
```

Instance runs emit one-line JSON `collection.run.started`, `collection.source.started`, `collection.source.finished` and `collection.run.finished` events with stable run/attempt IDs and clocks. Startup/scheduled/manual triggers are retained in SQLite. Successful counts distinguish new item identities from full revisions; zero new items/revisions after a successful poll is expected. Restricted/unsupported details remain explicit skips/link-only entries, not silently filled from older pages.

Failed sources retain null counts and approved phase/cause metadata. DNS/TLS/Undici/timeout/SQLite/filesystem codes and typed HTTP status are preserved when known; unknown exception data stays generic. Messages, stacks, response bodies, URLs, cookies and argument values are not operational log fields. Trusted CLI input failures have finite codes and static guidance. Unfinished history means an attempt may still be active or may have been interrupted; it is never treated as verified recovery or process liveness. See [the exact clocks and ledger scope](database.md#collection-operation-tables).

Canonical Compose uses Docker's `local` logging driver with `max-size: 10m` and `max-file: 3` per service, keeping container log retention bounded without an additional logging service. `docker compose logs` remains available. Persisted operation history is separate and is retained with the SQLite database/snapshots; no automatic database-history deletion policy is introduced.

Keep the default loopback bind for a controlled instance. A VPS/NAS uses this same image/config/local-volume contract, not a source fork; expose selected read-only feeds through an operator-managed TLS reverse proxy/firewall only after deployment acceptance. Do not serve SQLite/backups or mistake operator status for a new public dashboard. Future private data still requires a separate access-control decision.


## Security boundary

- no credentials are baked into the image;
- collection writes only to the local named volume;
- the optional API remains a read-only application path;
- the current official config collects public sources only;
- SQLite is not placed on WebDAV/FUSE/network mounts;
- private authentication/session support remains out of scope for this milestone.

Future private data belongs in the same canonical Docker/Compose instance architecture but must remain security-separated from public state and outputs.
