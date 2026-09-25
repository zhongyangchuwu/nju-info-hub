# SQLite persistence

## Driver decision

The persistence package uses Node.js 24's built-in `node:sqlite` `DatabaseSync` API. The schema and ingestion path need only prepared statements, transactions, foreign keys, and migrations; Drizzle would add an ORM and driver dependency without removing meaningful code at this stage. The synchronous API is acceptable because the current worker is a single-process command-line collector. A concurrent service would need a separate connection and concurrency design.

`InfoHubDatabase` is the writer: it opens with foreign keys enabled, a five-second busy timeout, WAL journaling, and `synchronous = NORMAL`. Schema versioning uses SQLite's `user_version` pragma. Fresh databases use v3; existing v1 databases migrate transactionally through the `published_on` backfill and observation-table addition, while v2 databases add only the observation table. Unknown versions are rejected rather than modified implicitly. Neither migration invents observations for historical full notices.

## Schema

```text
sources
  1 -> many raw_documents
  1 -> many source_items

source_items
  1 -> many source_item_observations
  1 -> many notice_revisions

raw_documents
  1 -> many source_item_observations (official list evidence)
  1 -> many notice_revisions (detail evidence)

notice_revisions
  1 -> many attachments
```

### `sources`

Stores the registry identity and provenance needed to interpret collected data: source name, organization, homepage/list URL, adapter type, enabled state, and the normalized source configuration as JSON. Re-registering an unchanged source is a no-op; a changed configuration updates the same source row.

### `raw_documents`

Stores the adapter input: source id, final URL after redirects, fetch time, content type, response SHA-256, decoded raw body, ETag, and Last-Modified. Rows are immutable and unique by `(source_id, final_url, sha256)`, so fetching identical content again does not duplicate it.

`RawDocument.body` is the collector's decoded text used by parsers. `RawDocument.sha256` remains the hash of the original response bytes, including for legacy encodings.

### `source_items`

Represents one publication identity at one source. Its stable key is `(source_id, source_item_id)`. The WebPlus adapter uses the same 24-character SHA-256 prefix of the discovered public item URL for both the list observation and later parsed detail; existing URL-derived IDs remain unchanged. `source_items.url` stores the original user-facing item link, which may differ from the redirected raw response URL. Cross-source identity is not inferred. A considered list candidate creates this row before detail acquisition; a legacy direct full ingest can still create it without an observation.

### `source_item_observations`

An append-only snapshot of a candidate actually considered by limited ingestion, linked to the official list `raw_document` that exposed it. It records title, original publication text, nullable normalized day, and acquisition kind (`webplus-detail`, `public-wechat`, or `external-public`), independently of detail success. A deterministic hash over these list fields makes reobservation idempotent; changed fields allocate the next observation revision for the same source item. This is list evidence, not an article body or a detail-acquisition attempt log. Recency lookahead pages may contain many rows that were never considered: those rows do not get observations.

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

Constraint failures roll back the whole notice ingest. Repeating the same source, raw document, notice, and attachments leaves row counts unchanged. Observation ingest separately upserts source/list raw/source item and its observation revision in one transaction immediately before detail acquisition. Unsupported or restricted details leave the observation and its list provenance intact. A later successful detail adds a full notice revision to the same item; a later unavailable attempt never removes a prior full revision.

## Persisted query

For read-only delivery, use `new InfoHubDatabaseReader(path)` from `@nju-info/db`. It exposes `listRecentNotices`, `listRecentSourceEntries`, `listSources`, `listOrganizations`, `stats`, `close`, and `[Symbol.dispose]`; these queries share their implementation with `InfoHubDatabase`. The reader opens an existing SQLite file with `DatabaseSync`'s `readOnly: true` option. It checks `PRAGMA user_version` and accepts only the current schema version; it does not create a missing file, migrate an old schema, configure journal/synchronous mode, or checkpoint. Upgrade an older database using the existing writer/ingest path before starting read-only delivery. SQLite permits reading a live WAL database subject to its WAL and filesystem sidecar requirements; a read-only SQLite connection may create `-wal`/`-shm` sidecars when permitted. Do not use `immutable=1` with a live writer because it disables change detection and locking.

`InfoHubDatabase.listRecentNotices({ sourceId?, organizationId?, limit? })` returns current revisions, not raw documents or a cross-source deduplicated identity. Both filters can be combined. The default limit is 50; limits must be integers from 1 to 100. A source item contributes only its highest revision number—even if older content is ingested again later. Results sort by `published_on` descending with nulls last, then source ID and source-item ID ascending. The query result includes current source name/organization, original publication text, normalized date, body, position-ordered attachments, and the linked raw document's fetch time and response SHA-256. An item's user-facing URL comes from `source_items.url`, not the redirected `raw_documents.final_url`; API and MCP consumers use the same query.

`InfoHubDatabase.listRecentSourceEntries` accepts the same source/organization/limit filters and order, but includes each source item with a latest list observation or latest full notice. A legacy full notice without list evidence is still `full`. An observation without detail is `link-only` and has no notice revision, body, or attachments; its title/date and fetch time/response hash come from the linked list raw document. An item with both remains `full`, retaining its full-notice title/date/body/attachments and detail-raw provenance even if a newer list observation could not be reacquired as detail. `acquisitionKind` and `observationRevisionNumber` are null for legacy full-only items; `noticeRevisionNumber` is null for link-only items. `listRecentNotices`, `/v1/notices/recent`, and MCP remain full-only.

`stats().sourceItemObservations` counts persisted observation revisions, not just current source items; it can exceed the number of link-only entries. `sourceItems` counts identities with either observations or full notices.

`InfoHubDatabase.listSources()` returns persisted source summaries (`id`, `name`, `organization: { id, name }`, `url`, `enabled`) ordered by source ID. `InfoHubDatabase.listOrganizations()` returns unique `{ id, name }` summaries derived from persisted sources, ordered by organization ID. If sources sharing an organization ID disagree on its name, the name from the lowest source ID wins; there is no separate organization table. Both queries reflect current persisted source metadata and return empty arrays for an empty database. They include sources with no notices and disabled sources; `enabled` does not change notice-filter behavior. Consumers can discover `sourceId` and `organizationId` for `listRecentNotices` using only this database package, without loading registry YAML.

`apps/api` opens this reader once at startup and serves the persisted query results without accessing registry YAML or the ingestion API. Its default loopback bind does not change SQLite's live-WAL sidecar requirements above; a reader must be able to access the live database and its sidecars. API startup fails for missing or unsupported-schema files rather than initializing them.

## Worker command

```bash
pnpm worker -- ingest <source-id> <database-path> [notice-limit]

# example
pnpm worker -- ingest nju-cs-graduate /tmp/nju-info.sqlite 10
```

The command persists list-page raw documents, considers candidates in publication-recency order, and records an observation for each candidate immediately before detail acquisition. Unsupported `public-wechat` and `external-public` acquisitions are reported and skipped before any detail request. Recognized campus-IP restrictions and NJU unified-identity redirects are reported and skipped after the ordinary public WebPlus request, without persisting a detail raw body or notice revision; their source item and list observation remain. Later candidates are tried until the requested usable count or the bounded 100-page discovery cap is reached; ordinary parsing/fetch failures abort after that candidate's observation. In the ingest summary, `itemsDiscovered` counts unique candidates actually considered (including skipped ones), not every item visible on fetched list pages; `noticesIngested` counts usable full notices persisted. The `fetch` command writes no database state.

## Deferred

The schema deliberately omits canonical cross-source notices, semantic deduplication, fetch-attempt history, REST/MCP output tables, FTS/vector indexes, queues, PostgreSQL, and parser-version tracking. Raw documents remain available for a later reparsing or migration path.
