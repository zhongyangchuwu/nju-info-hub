# Docker / GHCR

Docker Compose is the canonical product deployment for NJU Info Hub. GitHub Actions/Pages remains the official public reference publisher and CI surface, not a second user deployment architecture.

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

Collection and publication policy are intentionally separate. `collection.sources[].recentLimit` caps the initial bootstrap and later controls how many recent known items are refreshed for revision detection; incremental runs collect every unseen item until a fully-known list page establishes the history boundary. Full-detail acquisition is best-effort and does not refill from older items. `publication.sources` controls which persisted sources are exposed. Feed publication itself does not impose an item-count limit: every persisted current source entry is emitted. Published sources must also be collected by the same instance.

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

1. choose a new immutable GHCR revision/version tag;
2. update `NJU_INFO_IMAGE`;
3. pull and recreate the services.

```bash
docker compose pull
docker compose up -d
```

The scheduler performs collection using the new image while the SQLite volume is preserved.

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

## Security boundary

- no credentials are baked into the image;
- collection writes only to the local named volume;
- API/MCP remain read-only application paths;
- the current official config collects public sources only;
- SQLite is not placed on WebDAV/FUSE/network mounts;
- private authentication/session support remains out of scope for this milestone.

Future private data belongs in the same canonical Docker/Compose instance architecture but must remain security-separated from public state and outputs.
