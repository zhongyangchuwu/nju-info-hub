# SQLite persistence

## Driver decision

The persistence package uses Node.js 24's built-in `node:sqlite` `DatabaseSync` API. The schema and ingestion path need only prepared statements, transactions, foreign keys, and migrations; Drizzle would add an ORM and driver dependency without removing meaningful code at this stage. The synchronous API is acceptable because the current worker is a single-process command-line collector. A concurrent service would need a separate connection and concurrency design.

`InfoHubDatabase` is the writer: it opens with foreign keys enabled, a five-second busy timeout, WAL journaling, and `synchronous = NORMAL`. Schema versioning uses SQLite's `user_version` pragma. Fresh databases use v2; existing v1 databases migrate transactionally, backfilling `published_on` from the original raw publication text. Unknown versions are rejected rather than modified implicitly.

## Schema

```text
sources
  1 -> many raw_documents
  1 -> many source_items

source_items
  1 -> many notice_revisions

raw_documents
  1 -> many notice_revisions

notice_revisions
  1 -> many attachments
```

### `sources`

Stores the registry identity and provenance needed to interpret collected data: source name, organization, homepage/list URL, adapter type, enabled state, and the normalized source configuration as JSON. Re-registering an unchanged source is a no-op; a changed configuration updates the same source row.

### `raw_documents`

Stores the adapter input: source id, final URL after redirects, fetch time, content type, response SHA-256, decoded raw body, ETag, and Last-Modified. Rows are immutable and unique by `(source_id, final_url, sha256)`, so fetching identical content again does not duplicate it.

`RawDocument.body` is the collector's decoded text used by parsers. `RawDocument.sha256` remains the hash of the original response bytes, including for legacy encodings.

### `source_items`

Represents one publication identity at one source. Its stable key is `(source_id, source_item_id)`. The current WebPlus adapter derives `source_item_id` from the final detail URL. Cross-source identity is not inferred.

### `notice_revisions`

Stores a complete parsed-notice snapshot linked to both its source item and the raw document that produced it. Revision numbers increase per source item.

`published_at_raw` retains the source text. Nullable `published_on` is a validated `YYYY-MM-DD` calendar date, not a timestamp or an inferred timezone; missing/invalid dates remain null. The same normalizer drives WebPlus recency ordering and the v1 backfill.

Revision identity is `(source_item, content_sha256)`, where `content_sha256` hashes the parsed URL, title, raw publication date, text body, HTML body, and ordered attachment metadata. The derived `published_on` is deliberately excluded, preserving existing revision hashes and idempotency across migration. A meaningful parser-output or source-content change creates a new revision; an irrelevant raw markup change that normalizes to the same parsed notice does not.

### `attachments`

Stores ordered attachment URL, title, and optional media type for a specific notice revision. Position is the attachment identity within a revision, so the same URL may appear more than once with different positions or labels. Attachments are revision-scoped because source pages may add, remove, rename, or reorder files.

## Transactions and idempotency

A notice ingest runs in one `BEGIN IMMEDIATE` transaction:

1. insert or update source metadata;
2. insert the immutable raw document if unseen;
3. insert or update the source-item identity;
4. return the existing revision when its parsed-content hash already exists;
5. otherwise allocate the next revision number and insert its attachments.

Constraint failures roll back the whole notice ingest. Repeating the same source, raw document, notice, and attachments leaves row counts unchanged.

## Persisted query

For read-only delivery, use `new InfoHubDatabaseReader(path)` from `@nju-info/db`. It exposes only `listRecentNotices`, `listSources`, `listOrganizations`, `stats`, `close`, and `[Symbol.dispose]`; these queries share their implementation with `InfoHubDatabase`. The reader opens an existing SQLite file with `DatabaseSync`'s `readOnly: true` option. It checks `PRAGMA user_version` and accepts only the current schema version; it does not create a missing file, migrate an old schema, configure journal/synchronous mode, or checkpoint. Upgrade an older database using the existing writer/ingest path before starting read-only delivery. SQLite permits reading a live WAL database subject to its WAL and filesystem sidecar requirements; a read-only SQLite connection may create `-wal`/`-shm` sidecars when permitted. Do not use `immutable=1` with a live writer because it disables change detection and locking.

`InfoHubDatabase.listRecentNotices({ sourceId?, organizationId?, limit? })` returns current revisions, not raw documents or a cross-source deduplicated identity. Both filters can be combined. The default limit is 50; limits must be integers from 1 to 100. A source item contributes only its highest revision number—even if older content is ingested again later. Results sort by `published_on` descending with nulls last, then source ID and source-item ID ascending. The query result includes current source name/organization, original publication text, normalized date, body, position-ordered attachments, and the linked raw document's fetch time and response SHA-256. An item's URL comes from the raw document linked to its selected revision.

`InfoHubDatabase.listSources()` returns persisted source summaries (`id`, `name`, `organization: { id, name }`, `url`, `enabled`) ordered by source ID. `InfoHubDatabase.listOrganizations()` returns unique `{ id, name }` summaries derived from persisted sources, ordered by organization ID. If sources sharing an organization ID disagree on its name, the name from the lowest source ID wins; there is no separate organization table. Both queries reflect current persisted source metadata and return empty arrays for an empty database. They include sources with no notices and disabled sources; `enabled` does not change notice-filter behavior. Consumers can discover `sourceId` and `organizationId` for `listRecentNotices` using only this database package, without loading registry YAML.

`apps/api` opens this reader once at startup and serves the persisted query results without accessing registry YAML or the ingestion API. Its default loopback bind does not change SQLite's live-WAL sidecar requirements above; a reader must be able to access the live database and its sidecars. API startup fails for missing or unsupported-schema files rather than initializing them.

## Worker command

```bash
pnpm worker -- ingest <source-id> <database-path> [notice-limit]

# example
pnpm worker -- ingest nju-cs-graduate /tmp/nju-info.sqlite 10
```

The command persists list-page raw documents, fetches and parses up to the requested number of detail pages, persists each notice transactionally, and prints row counts plus inserted/unchanged revision counts.

## Deferred

The schema deliberately omits canonical cross-source notices, semantic deduplication, fetch-attempt history, REST/MCP output tables, FTS/vector indexes, queues, PostgreSQL, and parser-version tracking. Raw documents remain available for a later reparsing or migration path.
