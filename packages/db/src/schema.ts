import { normalizePublicationDate } from "@nju-info/core";
import type { DatabaseSync } from "node:sqlite";

export const DATABASE_SCHEMA_VERSION = 3;

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
  acquisition_kind TEXT NOT NULL CHECK (
    acquisition_kind IN ('webplus-detail', 'public-wechat', 'external-public')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (source_item_row_id, revision_number)
) STRICT;

CREATE INDEX source_item_observations_item_idx
  ON source_item_observations (source_item_row_id, revision_number DESC);
`;

export function migrateDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get();
  const currentVersion = Number(row?.user_version ?? 0);

  if (currentVersion === DATABASE_SCHEMA_VERSION) return;
  if (![0, 1, 2].includes(currentVersion)) {
    throw new Error(
      `unsupported database schema version ${currentVersion}; expected ${DATABASE_SCHEMA_VERSION}`,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion === 0) {
      database.exec(INITIAL_SCHEMA);
    } else if (currentVersion === 1) {
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
    database.exec(SOURCE_ITEM_OBSERVATIONS_SCHEMA);
    database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
