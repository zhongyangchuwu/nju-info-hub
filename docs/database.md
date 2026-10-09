# SQLite persistence

## Driver decision

The persistence package uses Node.js 24's built-in `node:sqlite` `DatabaseSync` API. The schema and ingestion path need only prepared statements, transactions, foreign keys, and migrations; Drizzle would add an ORM and driver dependency without removing meaningful code at this stage. The synchronous API is acceptable because the current collection runtime is single-process. A concurrent service would need a separate connection and concurrency design.

`InfoHubDatabase` is the writer: it opens with foreign keys enabled, a five-second busy timeout, WAL journaling, and `synchronous = NORMAL`. Schema versioning uses SQLite's `user_version` pragma. Fresh databases use v6; versions 0–5 migrate transactionally while preserving website history, applying the existing publication-day/observation upgrades when necessary and then adding authenticated social lifecycle tables. Unknown versions are rejected rather than modified implicitly. No migration invents historical observations or social publication authority.

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

Stores source identity and provenance: name, organization, homepage/list URL, adapter type and normalized configuration JSON. The physical pre-release `enabled` column remains for compatibility; website writers persist it as `1`. Unchanged website registration is a no-op; changed configuration updates the row. Standalone registration and ingestion both enclose ownership checks/writes in `BEGIN IMMEDIATE`. Authenticated social registrations use dedicated `social-acquisition` ownership, not a fake website SourceConfig; neither writer may replace the other kind's source ID, including across competing connections.

### `raw_documents`

Stores the adapter input: source id, final URL after redirects, fetch time, content type, response SHA-256, decoded raw body, ETag, and Last-Modified. Rows are immutable and unique by `(source_id, final_url, sha256)`, so fetching identical content again does not duplicate it.

`RawDocument.body` is the collector's decoded text used by parsers. `RawDocument.sha256` remains the hash of the original response bytes, including for legacy encodings.

### `source_items`

Represents one publication identity at one source. Its stable key is `(source_id, source_item_id)`. The WebPlus adapter uses the same 24-character SHA-256 prefix of the discovered public item URL for both the list observation and later parsed detail; existing URL-derived IDs remain unchanged. `source_items.url` stores the original user-facing item link, which may differ from the redirected raw response URL. Cross-source identity is not inferred. A considered list candidate creates this row before detail acquisition; a legacy direct full ingest can still create it without an observation.

### `source_item_observations`

An append-only snapshot of an official-list item observed during ingestion, linked to the list `raw_document` that exposed it. It records title, original publication text, nullable normalized day, and acquisition kind (`webplus-detail`, `public-wechat`, or `external-public`), independently of detail success. A deterministic hash over these list fields makes an unchanged **current** observation idempotent; a change, including a return to earlier metadata, allocates the next observation revision for the same source item. This is list evidence, not an article body or a detail-acquisition attempt log. Bootstrap and incremental lookahead pages are intentionally observed so later runs have a denser known frontier, even when their rows are not selected for detail enrichment.

### `notice_revisions`

Stores a complete parsed-notice snapshot linked to both its source item and the raw document that produced it. Revision numbers increase per source item.

`published_at_raw` retains the source text. Nullable `published_on` is a validated `YYYY-MM-DD` calendar date, not a timestamp or an inferred timezone; missing/invalid dates remain null. The same normalizer drives WebPlus recency ordering and the v1 backfill.

Revision identity is `(source_item, content_sha256)`, where `content_sha256` hashes the parsed URL, title, raw publication date, text body, HTML body, and ordered attachment metadata. The derived `published_on` is deliberately excluded, preserving existing revision hashes and idempotency across migration. A meaningful parser-output or source-content change creates a new revision; an irrelevant raw markup change that normalizes to the same parsed notice does not.

### `attachments`

Stores ordered attachment URL, title, and optional media type for a specific notice revision. Position is the attachment identity within a revision, so the same URL may appear more than once with different positions or labels. Attachments are revision-scoped because source pages may add, remove, rename, or reorder files.

### Authenticated social metadata tables

`social_import_operations` is immutable signed operation history: global operation ID/digest, source-scoped sequence, canonical authorization bytes, exact nullable bundle bytes, action/policy/clocks and original acknowledgment counts. `social_raw_blobs` retains exact supported public-safe metadata BLOB bytes by SHA-256; `social_operation_blobs` connects those bytes to receipts. These are distinct from website decoded `raw_documents`, not restricted provider bodies or captured media.

`social_source_state` holds the current complete trusted registration/fingerprint, native publisher ownership, qualification expiry, latest accepted sequence, terminal revocation and change clock. `social_item_revisions` links stable native `source_items` to immutable material snapshots/exact raw references; A→B→A produces revision 3, while identical latest metadata can be reauthorized without duplicating its content revision. `social_item_publications` records the current authorized revision, policy fingerprint, qualification expiry, actual upstream acquisition and per-item operation modification clocks. `social_item_suppressions` supports both existing-item and pre-content tombstones; only explicit signed restoration clears them.

`InfoHubDatabase.applySocialImport(input, now?)` takes untrusted `SocialImportInput` and invokes Core's real cryptographic/byte verifier before beginning one atomic write transaction. The transaction writes receipt/exact raw evidence before normalization, then applies current publication/withdrawal state. Failed normalization or lifecycle transitions roll back all related changes. Operation admission/replay expiry does not expire previously accepted unrelated content; serving follows qualification expiry/current policy/tombstones/revocation. Exact operation-ID/digest replay writes nothing and cannot undo a newer state; new IDs require a higher source sequence, and a changed digest under an existing ID rejects. Terminal native-source revocation cannot be bypassed by key rotation or publisher rebinding.

The [credentialed-public ADR](adr-credentialed-public-acquisition.md#authenticated-metadata-import-and-lifecycle) owns operator trust/signing/storage rules. The separate private importer publishes a new database filename only after successful commit; existing writer initialization still performs normal schema migrations. Databases/sidecars/backups contain private operator registration/authorization audit records even though item raw blobs are public-safe: never expose a DB dump as public publication.

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

`InfoHubDatabase.listRecentNotices({ sourceId?, organizationId?, limit? })` returns current revisions, not raw documents or a cross-source deduplicated identity. Both filters can be combined. The default limit is 50; limits must be integers from 1 to 100. A source item contributes only its highest revision number—even if older content is ingested again later. Results sort by `published_on` descending with nulls last, then source ID and source-item ID ascending. The query result includes current source name/organization, original publication text, normalized date, body, position-ordered attachments, and the linked raw document's fetch time and response SHA-256. An item's user-facing URL comes from `source_items.url`, not the redirected `raw_documents.final_url`; API consumers use the same query.

`InfoHubDatabase.listRecentSourceEntries` accepts the same source/organization/limit filters and day ordering, globally applied to the union of website observations/notices and currently authorized social metadata. Website full/link-only behavior is unchanged. Social rows are always link-only, with no fabricated observation/notice revision, body or attachments; optional `social: SocialEntryMetadata` retains native publisher/item identity, role, publication precision, attribution, policy version and material revision. `provenance.fetchedAt` is the upstream export's actual acquisition time; optional `modifiedAt` is the latest accepted item operation clock. Common writer/read-only reads exclude suppressed, revoked, qualification-expired and old-policy social items. `listRecentNotices` remains website full notices only.

`stats().sourceItemObservations` counts persisted observation revisions, not just current source items; it can exceed the number of link-only entries. `sourceItems` counts identities with either observations or full notices.

`listSources()` returns persisted `{ id, name, organization: { id, name }, url }` summaries ordered by ID, including registered sources with no current entries. Known social sources additionally expose `socialPublication: { status: 'active' | 'revoked' | 'expired', changedAt }`; revoked/expired metadata is retained so static exports can replace old feeds with empty current representations rather than fail as unknown IDs. `listOrganizations()` returns unique organizations ordered by ID; conflicting names use the lowest source ID, and there is no separate organization table. Neither query exposes operator trust/qualification/signatures or loads registry YAML.

`apps/api` opens this reader once at startup and serves the persisted query results without accessing registry YAML or the ingestion API. Its default loopback bind does not change SQLite's live-WAL sidecar requirements above; a reader must be able to access the live database and its sidecars. API startup fails for missing or unsupported-schema files rather than initializing them.

## Source command

```bash
pnpm nju-info -- source ingest <source-id> <database-path> [notice-limit]

# example
pnpm nju-info -- source ingest nju-cs-graduate /tmp/nju-info.sqlite 10
```

The source command persists list-page raw documents and records an observation for every unique row discovered on fetched list pages before detail acquisition. On first bootstrap it keeps a bounded recent window plus one lookahead page; on later runs it scans until the first page containing any known source item, scans one additional observation-only lookahead page if available, enriches unseen items only through the overlap page, and refreshes up to the configured number of newest known items for revision detection. If no known overlap appears within 10 search pages, the source fails before item observation or detail acquisition; the 100-page hard cap still applies. Unsupported `public-wechat` and `external-public` acquisitions remain link-only without a detail request. Recognized campus-IP restrictions and NJU unified-identity redirects remain link-only after the ordinary public WebPlus request, without persisting a detail raw body or notice revision. Link-only items do not trigger refill from older list rows; ordinary parsing/fetch failures abort after that item's observation. In the ingest summary, `itemsObserved` counts persisted list observations from the scanned pages and `noticesIngested` counts full notices persisted. The `fetch` command writes no database state.

## Deferred

The schema deliberately omits canonical cross-source notices, semantic deduplication, fetch-attempt history, REST output tables, FTS/vector indexes, queues, PostgreSQL, and parser-version tracking. Raw documents remain available for a later reparsing or migration path.
