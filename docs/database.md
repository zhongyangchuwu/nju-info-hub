# SQLite persistence

## Driver decision

The v0.1 persistence package uses Node.js 24's built-in `node:sqlite` `DatabaseSync` API. The schema and ingestion path need only prepared statements, transactions, foreign keys, and migrations; Drizzle would add an ORM and driver dependency without removing meaningful code at this stage. The synchronous API is acceptable because the current worker is a single-process command-line collector. A concurrent service would need a separate connection and concurrency design.

The database opens with foreign keys enabled, a five-second busy timeout, WAL journaling, and `synchronous = NORMAL`. Schema versioning uses SQLite's `user_version` pragma. A database with an unknown nonzero version is rejected rather than modified implicitly.

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

Revision identity is `(source_item, content_sha256)`, where `content_sha256` hashes the parsed URL, title, raw publication date, text body, HTML body, and ordered attachment metadata. Re-ingesting the same parsed content is idempotent. A meaningful parser-output or source-content change creates a new revision; an irrelevant raw markup change that normalizes to the same parsed notice does not.

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

## Worker command

```bash
pnpm worker -- ingest <source-id> <database-path> [notice-limit]

# example
pnpm worker -- ingest nju-cs-graduate /tmp/nju-info.sqlite 10
```

The command persists list-page raw documents, fetches and parses up to the requested number of detail pages, persists each notice transactionally, and prints row counts plus inserted/unchanged revision counts.

## Deferred

The v0.1 schema deliberately omits canonical cross-source notices, semantic deduplication, fetch-attempt history, REST/MCP output tables, FTS/vector indexes, queues, PostgreSQL, and parser-version tracking. Raw documents remain available for a later reparsing or migration path.
