import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizePublicationDate } from "@nju-info/core";
import type { Attachment, ParsedNotice, RawDocument, SourceConfig } from "@nju-info/core";
import { migrateDatabase } from "./schema.js";

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

export interface DatabaseStats {
  sources: number;
  rawDocuments: number;
  sourceItems: number;
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

export class InfoHubDatabase implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = NORMAL");
    migrateDatabase(this.#database);
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

  ingestNotice(
    source: SourceConfig,
    rawDocument: RawDocument,
    notice: ParsedNotice,
  ): NoticeIngestResult {
    this.#validateNotice(source, rawDocument, notice);

    return this.#transaction(() => {
      this.#writeSource(source);
      const persistedRaw = this.#writeRawDocument(rawDocument);
      const sourceItemRowId = this.#writeSourceItem(notice);
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
                r.revision_number, d.final_url AS url, r.title,
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
      noticeRevisions: count("notice_revisions"),
      attachments: count("attachments"),
    };
  }

  #validateSource(source: SourceConfig, rawDocument: RawDocument): void {
    if (source.id !== rawDocument.sourceId) {
      throw new Error(
        `source mismatch: config ${source.id}, raw document ${rawDocument.sourceId}`,
      );
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
    if (notice.url !== rawDocument.url) {
      throw new Error(
        `URL mismatch: raw document ${rawDocument.url}, notice ${notice.url}`,
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

  #writeSourceItem(notice: ParsedNotice): number {
    this.#database
      .prepare(
        `INSERT INTO source_items (
           source_id, source_item_id, url, first_seen_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, source_item_id) DO UPDATE SET
           url = excluded.url
         WHERE source_items.url <> excluded.url`,
      )
      .run(
        notice.sourceId,
        notice.sourceItemId,
        notice.url,
        notice.provenance.fetchedAt,
      );

    const row = this.#database
      .prepare(
        `SELECT id
           FROM source_items
          WHERE source_id = ? AND source_item_id = ?`,
      )
      .get(notice.sourceId, notice.sourceItemId);
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
