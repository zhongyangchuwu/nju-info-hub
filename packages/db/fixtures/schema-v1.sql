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
PRAGMA user_version = 1;
