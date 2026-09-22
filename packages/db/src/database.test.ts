import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";
import { InfoHubDatabase } from "./database.js";

const SOURCE: WebPlusSourceConfig = {
  schemaVersion: 1,
  id: "nju-test-notices",
  name: "Test notices",
  organization: {
    id: "nju-test",
    name: "Test organization",
  },
  url: "https://example.edu/notices/list.htm",
  audience: ["students"],
  categories: ["notices"],
  enabled: true,
  adapter: { type: "webplus" },
};

function rawDocument(body: string, fetchedAt: string): RawDocument {
  return {
    sourceId: SOURCE.id,
    url: "https://example.edu/notices/1/page.htm",
    fetchedAt,
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
    etag: '"notice-1"',
    lastModified: "Wed, 23 Sep 2026 10:00:00 GMT",
  };
}

function parsedNotice(
  raw: RawDocument,
  overrides: Partial<ParsedNotice> = {},
): ParsedNotice {
  return {
    sourceId: SOURCE.id,
    sourceItemId: "notice-1",
    url: raw.url,
    title: "Notice title",
    publishedAtRaw: "2026-09-23",
    bodyText: "Notice body",
    bodyHtml: "<p>Notice body</p>",
    attachments: [
      {
        url: "https://example.edu/_upload/article/files/notice.pdf",
        title: "notice.pdf",
        mediaType: "application/pdf",
      },
    ],
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
    ...overrides,
  };
}

function temporaryDatabase(): {
  directory: string;
  path: string;
  database: InfoHubDatabase;
} {
  const directory = mkdtempSync(join(tmpdir(), "nju-info-db-"));
  const path = join(directory, "test.sqlite");
  return { directory, path, database: new InfoHubDatabase(path) };
}

describe("InfoHubDatabase", () => {
  it("persists source provenance, raw content, notice data, and attachments", () => {
    const temporary = temporaryDatabase();
    try {
      const raw = rawDocument(
        "<html><p>Notice body</p></html>",
        "2026-09-23T10:00:00.000Z",
      );
      const notice = parsedNotice(raw);
      const result = temporary.database.ingestNotice(SOURCE, raw, notice);

      expect(result).toMatchObject({
        revisionNumber: 1,
        insertedRawDocument: true,
        insertedRevision: true,
      });
      expect(temporary.database.stats()).toEqual({
        sources: 1,
        rawDocuments: 1,
        sourceItems: 1,
        noticeRevisions: 1,
        attachments: 1,
      });

      const inspection = new DatabaseSync(temporary.path, { readOnly: true });
      try {
        expect(
          inspection
            .prepare(
              `SELECT id, name, organization_id, homepage_url, adapter_type
                 FROM sources`,
            )
            .get(),
        ).toMatchObject({
          id: SOURCE.id,
          name: SOURCE.name,
          organization_id: SOURCE.organization.id,
          homepage_url: SOURCE.url,
          adapter_type: "webplus",
        });
        expect(
          inspection
            .prepare(
              `SELECT final_url, fetched_at, content_type, sha256, body, etag,
                      last_modified
                 FROM raw_documents`,
            )
            .get(),
        ).toMatchObject({
          final_url: raw.url,
          fetched_at: raw.fetchedAt,
          content_type: raw.contentType,
          sha256: raw.sha256,
          body: raw.body,
          etag: raw.etag,
          last_modified: raw.lastModified,
        });
        expect(
          inspection
            .prepare(
              `SELECT source_items.source_item_id, notice_revisions.title,
                      notice_revisions.raw_document_id
                 FROM notice_revisions
                 JOIN source_items
                   ON source_items.id = notice_revisions.source_item_row_id`,
            )
            .get(),
        ).toMatchObject({
          source_item_id: notice.sourceItemId,
          title: notice.title,
          raw_document_id: result.rawDocumentId,
        });
        expect(
          inspection
            .prepare(
              `SELECT position, url, title, media_type
                 FROM attachments`,
            )
            .get(),
        ).toEqual({
          position: 0,
          url: notice.attachments[0]?.url,
          title: notice.attachments[0]?.title,
          media_type: notice.attachments[0]?.mediaType,
        });
      } finally {
        inspection.close();
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("preserves repeated attachment URLs at distinct positions", () => {
    const temporary = temporaryDatabase();
    try {
      const raw = rawDocument(
        "<html><p>Repeated attachment</p></html>",
        "2026-09-23T10:30:00.000Z",
      );
      const attachmentUrl =
        "https://example.edu/_upload/article/files/shared.pdf";
      const notice = parsedNotice(raw, {
        attachments: [
          {
            url: attachmentUrl,
            title: "Application form",
            mediaType: "application/pdf",
          },
          {
            url: attachmentUrl,
            title: "Download the same form",
            mediaType: "application/pdf",
          },
        ],
      });

      temporary.database.ingestNotice(SOURCE, raw, notice);
      expect(temporary.database.stats().attachments).toBe(2);

      const inspection = new DatabaseSync(temporary.path, { readOnly: true });
      try {
        expect(
          inspection
            .prepare(
              `SELECT position, url, title
                 FROM attachments
                ORDER BY position`,
            )
            .all(),
        ).toEqual([
          {
            position: 0,
            url: attachmentUrl,
            title: "Application form",
          },
          {
            position: 1,
            url: attachmentUrl,
            title: "Download the same form",
          },
        ]);
      } finally {
        inspection.close();
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("is idempotent and adds a revision only when parsed content changes", () => {
    const temporary = temporaryDatabase();
    try {
      const originalRaw = rawDocument(
        "<html><p>Notice body</p></html>",
        "2026-09-23T10:00:00.000Z",
      );
      const originalNotice = parsedNotice(originalRaw);

      const first = temporary.database.ingestNotice(
        SOURCE,
        originalRaw,
        originalNotice,
      );
      const duplicate = temporary.database.ingestNotice(
        SOURCE,
        originalRaw,
        originalNotice,
      );

      expect(first.insertedRevision).toBe(true);
      expect(duplicate).toMatchObject({
        revisionNumber: 1,
        insertedRawDocument: false,
        insertedRevision: false,
      });
      expect(temporary.database.stats()).toEqual({
        sources: 1,
        rawDocuments: 1,
        sourceItems: 1,
        noticeRevisions: 1,
        attachments: 1,
      });

      const changedRaw = rawDocument(
        "<html><p>Updated body</p></html>",
        "2026-09-23T11:00:00.000Z",
      );
      const changedNotice = parsedNotice(changedRaw, {
        title: "Updated notice title",
        bodyText: "Updated body",
        bodyHtml: "<p>Updated body</p>",
      });
      const changed = temporary.database.ingestNotice(
        SOURCE,
        changedRaw,
        changedNotice,
      );
      const changedDuplicate = temporary.database.ingestNotice(
        SOURCE,
        changedRaw,
        changedNotice,
      );

      expect(changed).toMatchObject({
        revisionNumber: 2,
        insertedRawDocument: true,
        insertedRevision: true,
      });
      expect(changedDuplicate).toMatchObject({
        revisionNumber: 2,
        insertedRawDocument: false,
        insertedRevision: false,
      });
      expect(temporary.database.stats()).toEqual({
        sources: 1,
        rawDocuments: 2,
        sourceItems: 1,
        noticeRevisions: 2,
        attachments: 2,
      });

      const inspection = new DatabaseSync(temporary.path, { readOnly: true });
      try {
        expect(
          inspection
            .prepare(
              `SELECT revision_number, title
                 FROM notice_revisions
                ORDER BY revision_number`,
            )
            .all(),
        ).toEqual([
          { revision_number: 1, title: "Notice title" },
          { revision_number: 2, title: "Updated notice title" },
        ]);
      } finally {
        inspection.close();
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
