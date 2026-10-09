import { normalizePublicationDate } from "@nju-info/core";
import type { DatabaseSync } from "node:sqlite";

export const DATABASE_SCHEMA_VERSION = 7;

const INITIAL_SCHEMA = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE raw_documents (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  final_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  content_type TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  body TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  UNIQUE (source_id, final_url, sha256)
) STRICT;

CREATE INDEX raw_documents_source_url_idx
  ON raw_documents (source_id, final_url, fetched_at DESC);

CREATE TABLE source_items (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE (source_id, source_item_id)
) STRICT;

CREATE TABLE notice_revisions (
  id INTEGER PRIMARY KEY,
  source_item_row_id INTEGER NOT NULL REFERENCES source_items(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  raw_document_id INTEGER NOT NULL REFERENCES raw_documents(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  title TEXT NOT NULL,
  published_at_raw TEXT,
  published_on TEXT,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_item_row_id, revision_number),
  UNIQUE (source_item_row_id, content_sha256)
) STRICT;

CREATE INDEX notice_revisions_item_idx
  ON notice_revisions (source_item_row_id, revision_number DESC);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  notice_revision_id INTEGER NOT NULL REFERENCES notice_revisions(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  media_type TEXT,
  UNIQUE (notice_revision_id, position)
) STRICT;
`;

const SOURCE_ITEM_OBSERVATIONS_SCHEMA = `
CREATE TABLE source_item_observations (
  id INTEGER PRIMARY KEY,
  source_item_row_id INTEGER NOT NULL REFERENCES source_items(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  raw_document_id INTEGER NOT NULL REFERENCES raw_documents(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  title TEXT NOT NULL,
  published_at_raw TEXT,
  published_on TEXT,
  acquisition_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_item_row_id, revision_number)
) STRICT;

CREATE INDEX source_item_observations_item_idx
  ON source_item_observations (source_item_row_id, revision_number DESC);
`;

const SOCIAL_IMPORT_SCHEMA = `
CREATE TABLE social_source_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  publisher_key TEXT NOT NULL UNIQUE,
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  registration_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
  changed_at TEXT NOT NULL,
  latest_sequence INTEGER NOT NULL CHECK (latest_sequence > 0)
) STRICT;

CREATE TABLE social_import_operations (
  operation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES social_source_state(source_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  operation_sha256 TEXT NOT NULL CHECK (length(operation_sha256) = 64),
  authorization_bytes BLOB NOT NULL,
  bundle_bytes BLOB,
  action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'suppress', 'revoke-source')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  imported_items INTEGER NOT NULL,
  suppressed_items INTEGER NOT NULL,
  UNIQUE (source_id, sequence)
) STRICT;

CREATE TABLE social_raw_blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  body BLOB NOT NULL
) STRICT;

CREATE TABLE social_operation_blobs (
  operation_id TEXT NOT NULL REFERENCES social_import_operations(operation_id),
  sha256 TEXT NOT NULL REFERENCES social_raw_blobs(sha256),
  PRIMARY KEY (operation_id, sha256)
) STRICT;

CREATE TABLE social_item_revisions (
  id INTEGER PRIMARY KEY,
  source_item_row_id INTEGER NOT NULL REFERENCES source_items(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  material_sha256 TEXT NOT NULL CHECK (length(material_sha256) = 64),
  payload_json TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES social_raw_blobs(sha256),
  operation_id TEXT NOT NULL REFERENCES social_import_operations(operation_id),
  created_at TEXT NOT NULL,
  UNIQUE (source_item_row_id, revision_number)
) STRICT;

CREATE TABLE social_item_publications (
  source_item_row_id INTEGER PRIMARY KEY REFERENCES source_items(id),
  revision_id INTEGER NOT NULL REFERENCES social_item_revisions(id),
  operation_id TEXT NOT NULL REFERENCES social_import_operations(operation_id),
  policy_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE social_item_suppressions (
  source_id TEXT NOT NULL REFERENCES social_source_state(source_id),
  source_item_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES social_import_operations(operation_id),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, source_item_id)
) STRICT;
`;

const COLLECTION_SCHEMA = `
CREATE TABLE collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'startup', 'scheduled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'unfinished'
    CHECK (outcome IN ('unfinished', 'success', 'partial-failure', 'failure')),
  succeeded_sources INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_sources >= 0),
  failed_sources INTEGER NOT NULL DEFAULT 0 CHECK (failed_sources >= 0),
  CHECK ((outcome = 'unfinished' AND finished_at IS NULL)
      OR (outcome <> 'unfinished' AND finished_at IS NOT NULL))
) STRICT;

CREATE TABLE collection_source_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES collection_runs(id),
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'unfinished'
    CHECK (outcome IN ('unfinished', 'success', 'failure')),
  counts_json TEXT,
  error_json TEXT,
  UNIQUE (run_id, source_id),
  CHECK ((outcome = 'unfinished' AND finished_at IS NULL AND counts_json IS NULL AND error_json IS NULL)
      OR (outcome = 'success' AND finished_at IS NOT NULL AND counts_json IS NOT NULL AND error_json IS NULL)
      OR (outcome = 'failure' AND finished_at IS NOT NULL AND counts_json IS NULL AND error_json IS NOT NULL))
) STRICT;

CREATE INDEX collection_source_attempts_run_idx ON collection_source_attempts (run_id, id);
CREATE INDEX collection_source_attempts_source_idx ON collection_source_attempts (source_id, id DESC);
`;

export function migrateDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get();
  const currentVersion = Number(row?.user_version ?? 0);

  if (currentVersion === DATABASE_SCHEMA_VERSION) return;
  if (![0, 1, 2, 3, 4, 5, 6].includes(currentVersion)) {
    throw new Error(
      `unsupported database schema version ${currentVersion}; expected ${DATABASE_SCHEMA_VERSION}`,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion === 0) {
      database.exec(INITIAL_SCHEMA);
      database.exec(SOURCE_ITEM_OBSERVATIONS_SCHEMA);
    } else if (currentVersion < 5) {
      if (currentVersion === 1) {
        database.exec("ALTER TABLE notice_revisions ADD COLUMN published_on TEXT");
        const rows = database
          .prepare("SELECT id, published_at_raw FROM notice_revisions")
          .iterate() as Iterable<{ id: number; published_at_raw: string | null }>;
        const update = database.prepare(
          "UPDATE notice_revisions SET published_on = ? WHERE id = ?",
        );
        for (const row of rows) {
          const publishedOn = normalizePublicationDate(row.published_at_raw);
          if (publishedOn !== null) update.run(publishedOn, row.id);
        }
      }

      if (currentVersion <= 2) {
        database.exec(SOURCE_ITEM_OBSERVATIONS_SCHEMA);
      } else {
        database.exec("DROP INDEX source_item_observations_item_idx");
        database.exec(
          "ALTER TABLE source_item_observations RENAME TO source_item_observations_legacy",
        );
        database.exec(SOURCE_ITEM_OBSERVATIONS_SCHEMA);
        database.exec(`
          INSERT INTO source_item_observations (
            id, source_item_row_id, revision_number, raw_document_id,
            content_sha256, title, published_at_raw, published_on,
            acquisition_kind, created_at
          )
          SELECT
            id, source_item_row_id, revision_number, raw_document_id,
            content_sha256, title, published_at_raw, published_on,
            acquisition_kind, created_at
          FROM source_item_observations_legacy
        `);
        database.exec("DROP TABLE source_item_observations_legacy");
      }
    }
    if (currentVersion < 6) database.exec(SOCIAL_IMPORT_SCHEMA);
    database.exec(COLLECTION_SCHEMA);
    database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
