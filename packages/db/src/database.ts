import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizePublicationDate } from "@nju-info/core";
import type {
  AcquisitionKind,
  Attachment,
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";
import { DATABASE_SCHEMA_VERSION, migrateDatabase } from "./schema.js";

export interface PersistedRawDocument {
  id: number;
  inserted: boolean;
}

export interface NoticeIngestResult {
  rawDocumentId: number;
  sourceItemRowId: number;
  noticeRevisionId: number;
  revisionNumber: number;
  insertedRawDocument: boolean;
  insertedRevision: boolean;
}

export interface SourceItemObservationResult {
  rawDocumentId: number;
  sourceItemRowId: number;
  observationRevisionId: number;
  revisionNumber: number;
  insertedRawDocument: boolean;
  insertedRevision: boolean;
}

export interface DatabaseStats {
  sources: number;
  rawDocuments: number;
  sourceItems: number;
  sourceItemObservations: number;
  noticeRevisions: number;
  attachments: number;
}

export interface PersistedOrganizationSummary {
  id: string;
  name: string;
}

export interface PersistedSourceSummary {
  id: string;
  name: string;
  organization: PersistedOrganizationSummary;
  url: string;
  enabled: boolean;
}

export interface RecentNoticeOptions {
  sourceId?: string;
  organizationId?: string;
  limit?: number;
}

/** A current, source-scoped revision; source metadata reflects the latest registry state. */
export interface NoticeQueryResult {
  sourceId: string;
  sourceItemId: string;
  sourceName: string;
  organization: { id: string; name: string };
  revisionNumber: number;
  url: string;
  title: string;
  publishedAtRaw: string | null;
  publishedOn: string | null;
  bodyText: string;
  bodyHtml: string;
  attachments: Attachment[];
  provenance: { fetchedAt: string; contentSha256: string };
}

export interface SourceEntryQueryResult {
  sourceId: string;
  sourceItemId: string;
  sourceName: string;
  organization: { id: string; name: string };
  url: string;
  title: string;
  publishedAtRaw: string | null;
  publishedOn: string | null;
  contentStatus: "full" | "link-only";
  acquisitionKind: AcquisitionKind | null;
  observationRevisionNumber: number | null;
  noticeRevisionNumber: number | null;
  bodyText: string;
  bodyHtml: string;
  attachments: Attachment[];
  provenance: { fetchedAt: string; contentSha256: string };
}

interface SourceSummaryRow {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  homepage_url: string;
  enabled: number;
}

interface NoticeQueryRow {
  revision_id: number;
  source_id: string;
  source_item_id: string;
  source_name: string;
  organization_id: string;
  organization_name: string;
  revision_number: number;
  url: string;
  title: string;
  published_at_raw: string | null;
  published_on: string | null;
  body_text: string;
  body_html: string;
  fetched_at: string;
  raw_sha256: string;
}

interface AttachmentRow {
  notice_revision_id: number;
  url: string;
  title: string;
  media_type: string | null;
}

interface RevisionRow {
  id: number;
  revision_number: number;
}

interface ObservationRevisionRow {
  id: number;
  revision_number: number;
}

interface SourceEntryQueryRow {
  revision_id: number | null;
  source_id: string;
  source_item_id: string;
  source_name: string;
  organization_id: string;
  organization_name: string;
  url: string;
  title: string;
  published_at_raw: string | null;
  published_on: string | null;
  acquisition_kind: AcquisitionKind | null;
  observation_revision_number: number | null;
  notice_revision_number: number | null;
  body_text: string | null;
  body_html: string | null;
  fetched_at: string;
  raw_sha256: string;
}

function numberField(
  row: Record<string, unknown> | undefined,
  field: string,
): number {
  const value = row?.[field];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`expected numeric SQLite field: ${field}`);
  }
  return Number(value);
}

function noticeContentSha256(notice: ParsedNotice): string {
  const payload = JSON.stringify({
    url: notice.url,
    title: notice.title,
    publishedAtRaw: notice.publishedAtRaw ?? null,
    bodyText: notice.bodyText,
    bodyHtml: notice.bodyHtml,
    attachments: notice.attachments.map((attachment) => ({
      url: attachment.url,
      title: attachment.title,
      mediaType: attachment.mediaType ?? null,
    })),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function observationContentSha256(item: DiscoveredItem): string {
  const payload = JSON.stringify({
    title: item.title,
    publishedAtRaw: item.publishedAtRaw ?? null,
    acquisitionKind: item.acquisitionKind,
  });
  return createHash("sha256").update(payload).digest("hex");
}


export class InfoHubDatabase implements Disposable {
  readonly #database: DatabaseSync;
  readonly #queries: DatabaseQueries;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = NORMAL");
    migrateDatabase(this.#database);
    this.#queries = new DatabaseQueries(this.#database);
  }

  close(): void {
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  upsertSource(source: SourceConfig): void {
    this.#writeSource(source);
  }

  persistRawDocument(
    source: SourceConfig,
    rawDocument: RawDocument,
  ): PersistedRawDocument {
    this.#validateSource(source, rawDocument);
    return this.#transaction(() => {
      this.#writeSource(source);
      return this.#writeRawDocument(rawDocument);
    });
  }

  observeSourceItem(
    source: SourceConfig,
    listRawDocument: RawDocument,
    item: DiscoveredItem,
  ): SourceItemObservationResult {
    this.#validateObservation(source, listRawDocument, item);

    return this.#transaction(() => {
      this.#writeSource(source);
      const persistedRaw = this.#writeRawDocument(listRawDocument);
      const sourceItemRowId = this.#writeSourceItem(
        item.sourceId,
        item.sourceItemId,
        item.url,
        listRawDocument.fetchedAt,
      );
      const contentSha256 = observationContentSha256(item);
      const existingRevision = this.#database
        .prepare(
          `SELECT id, revision_number
             FROM source_item_observations
            WHERE source_item_row_id = ? AND content_sha256 = ?`,
        )
        .get(sourceItemRowId, contentSha256) as ObservationRevisionRow | undefined;

      if (existingRevision) {
        return {
          rawDocumentId: persistedRaw.id,
          sourceItemRowId,
          observationRevisionId: existingRevision.id,
          revisionNumber: existingRevision.revision_number,
          insertedRawDocument: persistedRaw.inserted,
          insertedRevision: false,
        };
      }

      const revisionNumber = numberField(
        this.#database
          .prepare(
            `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
               FROM source_item_observations
              WHERE source_item_row_id = ?`,
          )
          .get(sourceItemRowId),
        "revision_number",
      );
      const observationInsert = this.#database
        .prepare(
          `INSERT INTO source_item_observations (
             source_item_row_id,
             revision_number,
             raw_document_id,
             content_sha256,
             title,
             published_at_raw,
             published_on,
             acquisition_kind,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceItemRowId,
          revisionNumber,
          persistedRaw.id,
          contentSha256,
          item.title,
          item.publishedAtRaw ?? null,
          normalizePublicationDate(item.publishedAtRaw),
          item.acquisitionKind,
          listRawDocument.fetchedAt,
        );

      return {
        rawDocumentId: persistedRaw.id,
        sourceItemRowId,
        observationRevisionId: Number(observationInsert.lastInsertRowid),
        revisionNumber,
        insertedRawDocument: persistedRaw.inserted,
        insertedRevision: true,
      };
    });
  }

  ingestNotice(
    source: SourceConfig,
    rawDocument: RawDocument,
    notice: ParsedNotice,
  ): NoticeIngestResult {
    this.#validateNotice(source, rawDocument, notice);

    return this.#transaction(() => {
      this.#writeSource(source);
      const persistedRaw = this.#writeRawDocument(rawDocument);
      const sourceItemRowId = this.#writeSourceItem(
        notice.sourceId,
        notice.sourceItemId,
        notice.url,
        notice.provenance.fetchedAt,
      );
      const contentSha256 = noticeContentSha256(notice);
      const existingRevision = this.#database
        .prepare(
          `SELECT id, revision_number
             FROM notice_revisions
            WHERE source_item_row_id = ? AND content_sha256 = ?`,
        )
        .get(sourceItemRowId, contentSha256) as RevisionRow | undefined;

      if (existingRevision) {
        return {
          rawDocumentId: persistedRaw.id,
          sourceItemRowId,
          noticeRevisionId: existingRevision.id,
          revisionNumber: existingRevision.revision_number,
          insertedRawDocument: persistedRaw.inserted,
          insertedRevision: false,
        };
      }

      const revisionNumber = numberField(
        this.#database
          .prepare(
            `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
               FROM notice_revisions
              WHERE source_item_row_id = ?`,
          )
          .get(sourceItemRowId),
        "revision_number",
      );
      const revisionInsert = this.#database
        .prepare(
          `INSERT INTO notice_revisions (
             source_item_row_id,
             revision_number,
             raw_document_id,
             content_sha256,
             title,
             published_at_raw,
             published_on,
             body_text,
             body_html,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceItemRowId,
          revisionNumber,
          persistedRaw.id,
          contentSha256,
          notice.title,
          notice.publishedAtRaw ?? null,
          notice.publishedOn,
          notice.bodyText,
          notice.bodyHtml,
          rawDocument.fetchedAt,
        );
      const noticeRevisionId = Number(revisionInsert.lastInsertRowid);
      const insertAttachment = this.#database.prepare(
        `INSERT INTO attachments (
           notice_revision_id, position, url, title, media_type
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [position, attachment] of notice.attachments.entries()) {
        insertAttachment.run(
          noticeRevisionId,
          position,
          attachment.url,
          attachment.title,
          attachment.mediaType ?? null,
        );
      }

      return {
        rawDocumentId: persistedRaw.id,
        sourceItemRowId,
        noticeRevisionId,
        revisionNumber,
        insertedRawDocument: persistedRaw.inserted,
        insertedRevision: true,
      };
    });
  }

  listSources(): PersistedSourceSummary[] {
    return this.#queries.listSources();
  }

  listOrganizations(): PersistedOrganizationSummary[] {
    return this.#queries.listOrganizations();
  }

  listRecentNotices(options: RecentNoticeOptions = {}): NoticeQueryResult[] {
    return this.#queries.listRecentNotices(options);
  }

  listRecentSourceEntries(options: RecentNoticeOptions = {}): SourceEntryQueryResult[] {
    return this.#queries.listRecentSourceEntries(options);
  }

  stats(): DatabaseStats {
    return this.#queries.stats();
  }

  #validateSource(source: SourceConfig, rawDocument: RawDocument): void {
    if (source.id !== rawDocument.sourceId) {
      throw new Error(
        `source mismatch: config ${source.id}, raw document ${rawDocument.sourceId}`,
      );
    }
  }

  #validateObservation(
    source: SourceConfig,
    rawDocument: RawDocument,
    item: DiscoveredItem,
  ): void {
    this.#validateSource(source, rawDocument);
    if (typeof rawDocument.url !== "string" || rawDocument.url.trim() === "") {
      throw new Error("list raw document URL must not be empty");
    }
    if (typeof rawDocument.fetchedAt !== "string" || rawDocument.fetchedAt.trim() === "") {
      throw new Error("list raw document fetchedAt must not be empty");
    }
    if (item.sourceId !== source.id) {
      throw new Error(
        `source mismatch: config ${source.id}, source item ${item.sourceId}`,
      );
    }
    if (typeof item.sourceItemId !== "string" || item.sourceItemId.trim() === "") {
      throw new Error("source item identity must not be empty");
    }
    if (typeof item.url !== "string" || item.url.trim() === "") {
      throw new Error("source item URL must not be empty");
    }
    if (typeof rawDocument.sha256 !== "string" || !/^[\da-f]{64}$/.test(rawDocument.sha256)) {
      throw new Error("list raw document hash must be a SHA-256 hex digest");
    }
    if (item.publishedAtRaw !== undefined && typeof item.publishedAtRaw !== "string") {
      throw new Error("source item publishedAtRaw must be a string when provided");
    }
    if (typeof item.title !== "string") {
      throw new Error("source item title must be a string");
    }
    if (item.acquisitionKind !== "webplus-detail"
      && item.acquisitionKind !== "public-wechat"
      && item.acquisitionKind !== "external-public") {
      throw new Error(`unsupported source item acquisition kind: ${item.acquisitionKind}`);
    }
  }

  #validateNotice(
    source: SourceConfig,
    rawDocument: RawDocument,
    notice: ParsedNotice,
  ): void {
    this.#validateSource(source, rawDocument);
    if (notice.sourceId !== source.id) {
      throw new Error(
        `source mismatch: config ${source.id}, notice ${notice.sourceId}`,
      );
    }
    if (notice.provenance.contentSha256 !== rawDocument.sha256) {
      throw new Error("notice provenance hash does not match raw document");
    }
    if (notice.provenance.fetchedAt !== rawDocument.fetchedAt) {
      throw new Error("notice provenance timestamp does not match raw document");
    }
    if (notice.publishedOn !== normalizePublicationDate(notice.publishedAtRaw)) {
      throw new Error("notice publishedOn does not match publishedAtRaw");
    }
  }

  #writeSource(source: SourceConfig): void {
    const now = new Date().toISOString();
    const configJson = JSON.stringify(source);
    this.#database
      .prepare(
        `INSERT INTO sources (
           id,
           name,
           organization_id,
           organization_name,
           homepage_url,
           adapter_type,
           config_json,
           enabled,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           organization_id = excluded.organization_id,
           organization_name = excluded.organization_name,
           homepage_url = excluded.homepage_url,
           adapter_type = excluded.adapter_type,
           config_json = excluded.config_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at
         WHERE sources.config_json <> excluded.config_json`,
      )
      .run(
        source.id,
        source.name,
        source.organization.id,
        source.organization.name,
        source.url,
        source.adapter.type,
        configJson,
        source.enabled ? 1 : 0,
        now,
        now,
      );
  }

  #writeRawDocument(rawDocument: RawDocument): PersistedRawDocument {
    const result = this.#database
      .prepare(
        `INSERT INTO raw_documents (
           source_id,
           final_url,
           fetched_at,
           content_type,
           sha256,
           body,
           etag,
           last_modified
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, final_url, sha256) DO NOTHING`,
      )
      .run(
        rawDocument.sourceId,
        rawDocument.url,
        rawDocument.fetchedAt,
        rawDocument.contentType,
        rawDocument.sha256,
        rawDocument.body,
        rawDocument.etag ?? null,
        rawDocument.lastModified ?? null,
      );

    if (Number(result.changes) === 1) {
      return { id: Number(result.lastInsertRowid), inserted: true };
    }

    const row = this.#database
      .prepare(
        `SELECT id
           FROM raw_documents
          WHERE source_id = ? AND final_url = ? AND sha256 = ?`,
      )
      .get(rawDocument.sourceId, rawDocument.url, rawDocument.sha256);
    return { id: numberField(row, "id"), inserted: false };
  }

  #writeSourceItem(
    sourceId: string,
    sourceItemId: string,
    url: string,
    firstSeenAt: string,
  ): number {
    this.#database
      .prepare(
        `INSERT INTO source_items (
           source_id, source_item_id, url, first_seen_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, source_item_id) DO UPDATE SET
           url = excluded.url
         WHERE source_items.url <> excluded.url`,
      )
      .run(sourceId, sourceItemId, url, firstSeenAt);

    const row = this.#database
      .prepare(
        `SELECT id
           FROM source_items
          WHERE source_id = ? AND source_item_id = ?`,
      )
      .get(sourceId, sourceItemId);
    return numberField(row, "id");
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Read-only access to an existing database at the current schema version. */
export class InfoHubDatabaseReader implements Disposable {
  readonly #database: DatabaseSync;
  readonly #queries: DatabaseQueries;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    try {
      const version = numberField(
        this.#database.prepare("PRAGMA user_version").get(),
        "user_version",
      );
      if (version !== DATABASE_SCHEMA_VERSION) {
        throw new Error(
          `unsupported database schema version ${version}; expected ${DATABASE_SCHEMA_VERSION}`,
        );
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
    this.#queries = new DatabaseQueries(this.#database);
  }

  listRecentNotices(options: RecentNoticeOptions = {}): NoticeQueryResult[] {
    return this.#queries.listRecentNotices(options);
  }

  listRecentSourceEntries(options: RecentNoticeOptions = {}): SourceEntryQueryResult[] {
    return this.#queries.listRecentSourceEntries(options);
  }

  listSources(): PersistedSourceSummary[] {
    return this.#queries.listSources();
  }

  listOrganizations(): PersistedOrganizationSummary[] {
    return this.#queries.listOrganizations();
  }

  stats(): DatabaseStats {
    return this.#queries.stats();
  }

  close(): void {
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

class DatabaseQueries {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  listSources(): PersistedSourceSummary[] {
    const rows = this.#database
      .prepare(
        `SELECT id, name, organization_id, organization_name, homepage_url, enabled
           FROM sources
          ORDER BY id`,
      )
      .all() as unknown as SourceSummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      organization: { id: row.organization_id, name: row.organization_name },
      url: row.homepage_url,
      enabled: row.enabled === 1,
    }));
  }

  listOrganizations(): PersistedOrganizationSummary[] {
    return this.#database
      .prepare(
        `WITH ranked AS (
           SELECT organization_id, organization_name,
                  ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY id) AS position
             FROM sources
         )
         SELECT organization_id AS id, organization_name AS name
           FROM ranked
          WHERE position = 1
          ORDER BY id`,
      )
      .all() as unknown as PersistedOrganizationSummary[];
  }

  listRecentNotices(options: RecentNoticeOptions = {}): NoticeQueryResult[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("recent notice limit must be an integer from 1 to 100");
    }

    const filters: string[] = [];
    const parameters: string[] = [];
    if (options.sourceId !== undefined) {
      filters.push("s.id = ?");
      parameters.push(options.sourceId);
    }
    if (options.organizationId !== undefined) {
      filters.push("s.organization_id = ?");
      parameters.push(options.organizationId);
    }
    const rows = this.#database
      .prepare(
        `SELECT r.id AS revision_id, s.id AS source_id,
                si.source_item_id, s.name AS source_name,
                s.organization_id, s.organization_name,
                r.revision_number, si.url, r.title,
                r.published_at_raw, r.published_on, r.body_text, r.body_html,
                d.fetched_at, d.sha256 AS raw_sha256
           FROM notice_revisions r
           JOIN source_items si ON si.id = r.source_item_row_id
           JOIN sources s ON s.id = si.source_id
           JOIN raw_documents d ON d.id = r.raw_document_id
          WHERE NOT EXISTS (
            SELECT 1 FROM notice_revisions newer
             WHERE newer.source_item_row_id = r.source_item_row_id
               AND newer.revision_number > r.revision_number
          )${filters.length ? ` AND ${filters.join(" AND ")}` : ""}
          ORDER BY r.published_on IS NULL, r.published_on DESC,
                   s.id, si.source_item_id
          LIMIT ?`,
      )
      .all(...parameters, limit) as unknown as NoticeQueryRow[];
    if (rows.length === 0) return [];

    const attachments = new Map<number, Attachment[]>();
    const attachmentRows = this.#database
      .prepare(
        `SELECT notice_revision_id, url, title, media_type
           FROM attachments
          WHERE notice_revision_id IN (${rows.map(() => "?").join(", ")})
          ORDER BY notice_revision_id, position`,
      )
      .all(...rows.map((row) => row.revision_id)) as unknown as AttachmentRow[];
    for (const row of attachmentRows) {
      const ordered = attachments.get(row.notice_revision_id) ?? [];
      ordered.push({
        url: row.url,
        title: row.title,
        ...(row.media_type === null ? {} : { mediaType: row.media_type }),
      });
      attachments.set(row.notice_revision_id, ordered);
    }

    return rows.map((row) => ({
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      sourceName: row.source_name,
      organization: { id: row.organization_id, name: row.organization_name },
      revisionNumber: row.revision_number,
      url: row.url,
      title: row.title,
      publishedAtRaw: row.published_at_raw,
      publishedOn: row.published_on,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      attachments: attachments.get(row.revision_id) ?? [],
      provenance: {
        fetchedAt: row.fetched_at,
        contentSha256: row.raw_sha256,
      },
    }));
  }

  listRecentSourceEntries(options: RecentNoticeOptions = {}): SourceEntryQueryResult[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("recent source entry limit must be an integer from 1 to 100");
    }

    const filters: string[] = [];
    const parameters: string[] = [];
    if (options.sourceId !== undefined) {
      filters.push("s.id = ?");
      parameters.push(options.sourceId);
    }
    if (options.organizationId !== undefined) {
      filters.push("s.organization_id = ?");
      parameters.push(options.organizationId);
    }
    const rows = this.#database
      .prepare(
        `WITH latest_observations AS (
           SELECT o.id, o.source_item_row_id, o.revision_number,
                  o.title, o.published_at_raw, o.published_on,
                  o.acquisition_kind, d.fetched_at, d.sha256 AS raw_sha256
             FROM source_item_observations o
             JOIN raw_documents d ON d.id = o.raw_document_id
            WHERE NOT EXISTS (
              SELECT 1 FROM source_item_observations newer
               WHERE newer.source_item_row_id = o.source_item_row_id
                 AND newer.revision_number > o.revision_number
            )
         ), latest_notices AS (
           SELECT r.id, r.source_item_row_id, r.revision_number,
                  r.title, r.published_at_raw, r.published_on,
                  r.body_text, r.body_html, d.fetched_at, d.sha256 AS raw_sha256
             FROM notice_revisions r
             JOIN raw_documents d ON d.id = r.raw_document_id
            WHERE NOT EXISTS (
              SELECT 1 FROM notice_revisions newer
               WHERE newer.source_item_row_id = r.source_item_row_id
                 AND newer.revision_number > r.revision_number
            )
         )
         SELECT n.id AS revision_id, s.id AS source_id,
                si.source_item_id, s.name AS source_name,
                s.organization_id, s.organization_name, si.url,
                CASE WHEN n.id IS NOT NULL THEN n.title ELSE o.title END AS title,
                CASE WHEN n.id IS NOT NULL THEN n.published_at_raw
                     ELSE o.published_at_raw END AS published_at_raw,
                CASE WHEN n.id IS NOT NULL THEN n.published_on
                     ELSE o.published_on END AS published_on,
                o.acquisition_kind,
                o.revision_number AS observation_revision_number,
                n.revision_number AS notice_revision_number,
                n.body_text, n.body_html,
                CASE WHEN n.id IS NOT NULL THEN n.fetched_at ELSE o.fetched_at END AS fetched_at,
                CASE WHEN n.id IS NOT NULL THEN n.raw_sha256 ELSE o.raw_sha256 END AS raw_sha256
           FROM source_items si
           JOIN sources s ON s.id = si.source_id
           LEFT JOIN latest_observations o ON o.source_item_row_id = si.id
           LEFT JOIN latest_notices n ON n.source_item_row_id = si.id
          WHERE (o.id IS NOT NULL OR n.id IS NOT NULL)
            ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
          ORDER BY CASE WHEN n.id IS NOT NULL THEN n.published_on ELSE o.published_on END IS NULL,
                   CASE WHEN n.id IS NOT NULL THEN n.published_on ELSE o.published_on END DESC,
                   s.id, si.source_item_id
          LIMIT ?`,
      )
      .all(...parameters, limit) as unknown as SourceEntryQueryRow[];
    if (rows.length === 0) return [];

    const noticeRevisionIds = rows.flatMap((row) =>
      row.revision_id === null ? [] : [row.revision_id],
    );
    const attachments = new Map<number, Attachment[]>();
    if (noticeRevisionIds.length > 0) {
      const attachmentRows = this.#database
        .prepare(
          `SELECT notice_revision_id, url, title, media_type
             FROM attachments
            WHERE notice_revision_id IN (${noticeRevisionIds.map(() => "?").join(", ")})
            ORDER BY notice_revision_id, position`,
        )
        .all(...noticeRevisionIds) as unknown as AttachmentRow[];
      for (const row of attachmentRows) {
        const ordered = attachments.get(row.notice_revision_id) ?? [];
        ordered.push({
          url: row.url,
          title: row.title,
          ...(row.media_type === null ? {} : { mediaType: row.media_type }),
        });
        attachments.set(row.notice_revision_id, ordered);
      }
    }

    return rows.map((row) => ({
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      sourceName: row.source_name,
      organization: { id: row.organization_id, name: row.organization_name },
      url: row.url,
      title: row.title,
      publishedAtRaw: row.published_at_raw,
      publishedOn: row.published_on,
      contentStatus: row.revision_id === null ? "link-only" : "full",
      acquisitionKind: row.acquisition_kind,
      observationRevisionNumber: row.observation_revision_number,
      noticeRevisionNumber: row.notice_revision_number,
      bodyText: row.body_text ?? "",
      bodyHtml: row.body_html ?? "",
      attachments: row.revision_id === null
        ? []
        : attachments.get(row.revision_id) ?? [],
      provenance: {
        fetchedAt: row.fetched_at,
        contentSha256: row.raw_sha256,
      },
    }));
  }

  stats(): DatabaseStats {
    const count = (table: string): number =>
      numberField(
        this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        "count",
      );

    return {
      sources: count("sources"),
      rawDocuments: count("raw_documents"),
      sourceItems: count("source_items"),
      sourceItemObservations: count("source_item_observations"),
      noticeRevisions: count("notice_revisions"),
      attachments: count("attachments"),
    };
  }
}
