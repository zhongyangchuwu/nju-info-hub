import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { normalizePublicationDate } from "@nju-info/core";
import type {
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";
import { DATABASE_SCHEMA_VERSION, migrateDatabase } from "./schema.js";
import { InfoHubDatabase, InfoHubDatabaseReader } from "./database.js";

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
    publishedOn: normalizePublicationDate(overrides.publishedAtRaw ?? "2026-09-23"),
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

const OTHER_SOURCE: WebPlusSourceConfig = {
  ...SOURCE,
  id: "nju-other-notices",
  name: "Other notices",
  organization: { id: "nju-other", name: "Other organization" },
};

const SIBLING_SOURCE: WebPlusSourceConfig = {
  ...SOURCE,
  id: "nju-sibling-notices",
  name: "Sibling notices",
};

function ingestItem(
  database: InfoHubDatabase,
  source: WebPlusSourceConfig,
  itemId: string,
  publishedAtRaw: string | undefined,
  fetchedAt = "2026-09-23T10:00:00.000Z",
) {
  const body = `<p>${itemId}</p>`;
  const raw = {
    ...rawDocument(body, fetchedAt),
    sourceId: source.id,
    url: `https://example.edu/notices/${itemId}/page.htm`,
  };
  const notice = parsedNotice(raw, {
    sourceId: source.id,
    sourceItemId: itemId,
    ...(publishedAtRaw === undefined ? {} : { publishedAtRaw }),
    publishedOn: normalizePublicationDate(publishedAtRaw),
    bodyText: itemId,
    bodyHtml: body,
  });
  if (publishedAtRaw === undefined) delete notice.publishedAtRaw;
  return { raw, notice, result: database.ingestNotice(source, raw, notice) };
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
        expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
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
                      notice_revisions.raw_document_id, notice_revisions.published_on
                 FROM notice_revisions
                 JOIN source_items
                   ON source_items.id = notice_revisions.source_item_row_id`,
            )
            .get(),
        ).toMatchObject({
          source_item_id: notice.sourceItemId,
          title: notice.title,
          raw_document_id: result.rawDocumentId,
          published_on: "2026-09-23",
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

  it("keeps the public item URL while storing the redirect target as raw provenance", () => {
    const temporary = temporaryDatabase();
    try {
      const raw = rawDocument("<p>Redirected notice</p>", "2026-09-23T10:00:00.000Z");
      const publicUrl = raw.url;
      raw.url = "https://example.edu/notices/1/page.psp";
      const notice = parsedNotice(raw, { url: publicUrl });

      expect(temporary.database.ingestNotice(SOURCE, raw, notice)).toMatchObject({
        insertedRevision: true,
      });
      expect(temporary.database.listRecentNotices()).toEqual([
        expect.objectContaining({
          url: publicUrl,
          provenance: {
            fetchedAt: raw.fetchedAt,
            contentSha256: raw.sha256,
          },
        }),
      ]);

      const inspection = new DatabaseSync(temporary.path, { readOnly: true });
      try {
        expect(inspection.prepare("SELECT final_url FROM raw_documents").get()).toEqual({
          final_url: raw.url,
        });
        expect(inspection.prepare("SELECT url FROM source_items").get()).toEqual({
          url: publicUrl,
        });
      } finally {
        inspection.close();
      }
      const reader = new InfoHubDatabaseReader(temporary.path);
      try {
        expect(reader.listRecentNotices()[0]?.url).toBe(publicUrl);
      } finally {
        reader.close();
      }

      expect(() => temporary.database.ingestNotice(SOURCE, raw, {
        ...notice,
        provenance: { ...notice.provenance, contentSha256: "0".repeat(64) },
      })).toThrow("notice provenance hash does not match raw document");
      expect(() => temporary.database.ingestNotice(SOURCE, raw, {
        ...notice,
        sourceId: "other-source",
      })).toThrow("source mismatch");
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
  it("returns no metadata from an empty database", () => {
    const temporary = temporaryDatabase();
    try {
      expect(temporary.database.listSources()).toEqual([]);
      expect(temporary.database.listOrganizations()).toEqual([]);
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("discovers persisted source and organization filters without requiring notices", () => {
    const temporary = temporaryDatabase();
    try {
      const disabledSibling = { ...SIBLING_SOURCE, enabled: false };
      temporary.database.upsertSource(SOURCE);
      temporary.database.upsertSource(disabledSibling);
      temporary.database.upsertSource(OTHER_SOURCE);
      ingestItem(temporary.database, SOURCE, "notice", "2026-09-23");

      const sources = temporary.database.listSources();
      const organizations = temporary.database.listOrganizations();
      expect(sources).toEqual([
        {
          id: OTHER_SOURCE.id, name: OTHER_SOURCE.name,
          organization: OTHER_SOURCE.organization, url: OTHER_SOURCE.url, enabled: true,
        },
        {
          id: disabledSibling.id, name: disabledSibling.name,
          organization: disabledSibling.organization, url: disabledSibling.url, enabled: false,
        },
        {
          id: SOURCE.id, name: SOURCE.name,
          organization: SOURCE.organization, url: SOURCE.url, enabled: true,
        },
      ]);
      expect(organizations).toEqual([
        OTHER_SOURCE.organization,
        SOURCE.organization,
      ]);
      const noticeSource = sources[2];
      const disabledSource = sources[1];
      const noticeOrganization = organizations[1];
      if (!noticeSource || !disabledSource || !noticeOrganization) {
        throw new Error("expected persisted source and organization filters");
      }
      expect(temporary.database.listRecentNotices({ sourceId: noticeSource.id })
        .map((row) => row.sourceItemId)).toEqual(["notice"]);
      expect(temporary.database.listRecentNotices({ organizationId: noticeOrganization.id })
        .map((row) => row.sourceItemId)).toEqual(["notice"]);
      expect(temporary.database.listRecentNotices({ sourceId: disabledSource.id })).toEqual([]);
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("uses the lowest source ID for conflicting organization names after metadata updates", () => {
    const temporary = temporaryDatabase();
    try {
      temporary.database.upsertSource(SOURCE);
      temporary.database.upsertSource(SIBLING_SOURCE);
      const updatedSibling = {
        ...SIBLING_SOURCE,
        name: "Updated sibling",
        url: "https://example.edu/updated/list.htm",
        organization: { id: SOURCE.organization.id, name: "Z alternate name" },
      };
      temporary.database.upsertSource(updatedSibling);

      expect(temporary.database.listSources()).toEqual([
        {
          id: updatedSibling.id, name: updatedSibling.name,
          organization: updatedSibling.organization, url: updatedSibling.url, enabled: true,
        },
        {
          id: SOURCE.id, name: SOURCE.name,
          organization: SOURCE.organization, url: SOURCE.url, enabled: true,
        },
      ]);
      expect(temporary.database.listOrganizations()).toEqual([updatedSibling.organization]);
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("lists only current revisions in deterministic publication order with source filters", () => {
    const temporary = temporaryDatabase();
    try {
      ingestItem(temporary.database, SOURCE, "old", "2026-08-20");
      ingestItem(temporary.database, SOURCE, "tie-b", "09-21 2026");
      ingestItem(temporary.database, SOURCE, "tie-a", "2026-09-21");
      ingestItem(temporary.database, SIBLING_SOURCE, "same-date", "2026-09-21");
      ingestItem(temporary.database, OTHER_SOURCE, "newest", "2026-09-22");
      ingestItem(temporary.database, SOURCE, "invalid", "2026-02-29");
      ingestItem(temporary.database, SOURCE, "missing", undefined);

      const all = temporary.database.listRecentNotices();
      expect(all.map(({ sourceItemId }) => sourceItemId)).toEqual([
        "newest", "same-date", "tie-a", "tie-b", "old", "invalid", "missing",
      ]);
      expect(all.map(({ publishedOn }) => publishedOn)).toEqual([
        "2026-09-22", "2026-09-21", "2026-09-21", "2026-09-21",
        "2026-08-20", null, null,
      ]);
      expect(temporary.database.listRecentNotices({ limit: 2 }).map((row) => row.sourceItemId))
        .toEqual(["newest", "same-date"]);
      expect(temporary.database.listRecentNotices({ sourceId: SOURCE.id })
        .map((row) => row.sourceItemId)).toEqual([
          "tie-a", "tie-b", "old", "invalid", "missing",
        ]);
      expect(temporary.database.listRecentNotices({ organizationId: SOURCE.organization.id })
        .map((row) => row.sourceItemId)).toEqual([
          "same-date", "tie-a", "tie-b", "old", "invalid", "missing",
        ]);
      expect(temporary.database.listRecentNotices({
        sourceId: SIBLING_SOURCE.id,
        organizationId: SOURCE.organization.id,
      }).map((row) => row.sourceItemId)).toEqual(["same-date"]);
      expect(temporary.database.listRecentNotices({
        sourceId: OTHER_SOURCE.id,
        organizationId: SOURCE.organization.id,
      })).toEqual([]);
      expect(temporary.database.listRecentNotices({ sourceId: "unknown" })).toEqual([]);
      for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
        expect(() => temporary.database.listRecentNotices({ limit })).toThrow(
          "recent notice limit must be an integer from 1 to 100",
        );
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("returns the latest snapshot with ordered attachments and linked raw provenance", () => {
    const temporary = temporaryDatabase();
    try {
      const first = ingestItem(temporary.database, SOURCE, "changed", "2026-09-23");
      const changedRaw = rawDocument("<p>updated</p>", "2026-09-24T12:00:00.000Z");
      changedRaw.url = first.raw.url;
      const changedNotice = parsedNotice(changedRaw, {
        sourceItemId: "changed",
        publishedAtRaw: "09-20 2026",
        publishedOn: "2026-09-20",
        title: "Updated title",
        bodyText: "updated",
        bodyHtml: "<p>updated</p>",
        attachments: [
          { url: "https://example.edu/z.pdf", title: "First" },
          { url: "https://example.edu/z.pdf", title: "Second", mediaType: "application/pdf" },
        ],
      });
      const second = temporary.database.ingestNotice(SOURCE, changedRaw, changedNotice);
      expect(second.revisionNumber).toBe(2);
      const replay = temporary.database.ingestNotice(SOURCE, first.raw, first.notice);
      expect(replay).toMatchObject({ revisionNumber: 1, insertedRevision: false });

      expect(temporary.database.listRecentNotices()).toEqual([{
        sourceId: SOURCE.id,
        sourceItemId: "changed",
        sourceName: SOURCE.name,
        organization: SOURCE.organization,
        revisionNumber: 2,
        url: changedRaw.url,
        title: "Updated title",
        publishedAtRaw: "09-20 2026",
        publishedOn: "2026-09-20",
        bodyText: "updated",
        bodyHtml: "<p>updated</p>",
        attachments: changedNotice.attachments,
        provenance: {
          fetchedAt: changedRaw.fetchedAt,
          contentSha256: changedRaw.sha256,
        },
      }]);
      ingestItem(temporary.database, SOURCE, "between", "2026-09-22");
      expect(temporary.database.listRecentNotices().map((row) => row.sourceItemId))
        .toEqual(["between", "changed"]);
      expect(temporary.database.listRecentNotices({ limit: 1 })[0]?.sourceItemId)
        .toBe("between");
      expect(temporary.database.stats().noticeRevisions).toBe(3);
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
  it("backfills a populated v1 database without changing history or identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-info-v1-"));
    const path = join(directory, "legacy.sqlite");
    const raw = rawDocument("<html><p>Notice body</p></html>", "2026-09-23T10:00:00.000Z");
    const notice = parsedNotice(raw, {
      publishedAtRaw: "09-21 2026",
      publishedOn: "2026-09-21",
    });
    const legacyNotices = [
      notice,
      parsedNotice(raw, {
        title: "Year-first revision",
        publishedAtRaw: "2026-09-22",
        publishedOn: "2026-09-22",
        attachments: [],
      }),
      parsedNotice(raw, {
        title: "Invalid-date revision",
        publishedAtRaw: "2026-02-29",
        publishedOn: null,
        attachments: [],
      }),
    ];

    try {
      const legacy = new DatabaseSync(path);
      let before: Record<string, unknown>[] = [];
      try {
        legacy.exec(readFileSync(new URL("../fixtures/schema-v1.sql", import.meta.url), "utf8"));
        legacy.prepare(
          `INSERT INTO sources (id, name, organization_id, organization_name,
             homepage_url, adapter_type, config_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(SOURCE.id, SOURCE.name, SOURCE.organization.id,
          SOURCE.organization.name, SOURCE.url, "webplus", JSON.stringify(SOURCE),
          1, raw.fetchedAt, raw.fetchedAt);
        legacy.prepare(
          `INSERT INTO raw_documents
             (id, source_id, final_url, fetched_at, content_type, sha256, body, etag, last_modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(7, SOURCE.id, raw.url, raw.fetchedAt, raw.contentType, raw.sha256,
          raw.body, raw.etag ?? null, raw.lastModified ?? null);
        legacy.prepare(
          `INSERT INTO source_items (id, source_id, source_item_id, url, first_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(11, SOURCE.id, notice.sourceItemId, notice.url, raw.fetchedAt);
        const insertRevision = legacy.prepare(
          `INSERT INTO notice_revisions
             (id, source_item_row_id, revision_number, raw_document_id, content_sha256,
              title, published_at_raw, body_text, body_html, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, revision] of legacyNotices.entries()) {
          // The derived date must not change the original v1 revision identity.
          const revisionHash = createHash("sha256")
            .update(JSON.stringify({
              url: revision.url,
              title: revision.title,
              publishedAtRaw: revision.publishedAtRaw,
              bodyText: revision.bodyText,
              bodyHtml: revision.bodyHtml,
              attachments: revision.attachments.map(({ url, title, mediaType }) => ({
                url, title, mediaType: mediaType ?? null,
              })),
            }))
            .digest("hex");
          insertRevision.run(13 + index, 11, index + 1, 7, revisionHash,
            revision.title, revision.publishedAtRaw ?? null,
            revision.bodyText, revision.bodyHtml, raw.fetchedAt);
        }
        legacy.prepare(
          `INSERT INTO attachments (notice_revision_id, position, url, title, media_type)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(13, 0, notice.attachments[0]!.url,
          notice.attachments[0]!.title, notice.attachments[0]!.mediaType ?? null);
        before = legacy.prepare("SELECT * FROM notice_revisions ORDER BY id").all();
      } finally {
        legacy.close();
      }

      const database = new InfoHubDatabase(path);
      try {
        const inspection = new DatabaseSync(path, { readOnly: true });
        try {
          expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
          expect(inspection.prepare("SELECT * FROM notice_revisions ORDER BY id").all())
            .toEqual(before.map((row, index) => ({
              ...row,
              published_on: ["2026-09-21", "2026-09-22", null][index],
            })));
          expect(inspection.prepare("SELECT notice_revision_id, position, url, title, media_type FROM attachments").all())
            .toEqual([{ notice_revision_id: 13, position: 0,
              url: notice.attachments[0]!.url, title: notice.attachments[0]!.title,
              media_type: notice.attachments[0]!.mediaType ?? null }]);
        } finally {
          inspection.close();
        }
        expect(database.listRecentNotices()).toEqual([expect.objectContaining({
          sourceItemId: notice.sourceItemId,
          revisionNumber: 3,
          publishedAtRaw: "2026-02-29",
          publishedOn: null,
          provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
        })]);
        expect(database.ingestNotice(SOURCE, raw, notice)).toMatchObject({
          rawDocumentId: 7, sourceItemRowId: 11, noticeRevisionId: 13,
          revisionNumber: 1, insertedRevision: false,
        });
        expect(database.stats().noticeRevisions).toBe(3);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects unknown database schema versions without changing them", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA user_version = 3");
      expect(() => migrateDatabase(database)).toThrow(
        "unsupported database schema version 3; expected 2",
      );
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    } finally {
      database.close();
    }
  });
});

describe("InfoHubDatabaseReader", () => {
  it("returns the same persisted queries as the writer without exposing ingestion", () => {
    const temporary = temporaryDatabase();
    try {
      temporary.database.upsertSource(SIBLING_SOURCE);
      ingestItem(temporary.database, SOURCE, "first", "2026-09-23");
      ingestItem(temporary.database, OTHER_SOURCE, "second", "2026-09-22");

      const reader = new InfoHubDatabaseReader(temporary.path);
      try {
        expect(reader.listSources()).toEqual(temporary.database.listSources());
        expect(reader.listOrganizations()).toEqual(temporary.database.listOrganizations());
        expect(reader.listRecentNotices()).toEqual(temporary.database.listRecentNotices());
        expect(reader.listRecentNotices({ sourceId: SOURCE.id, limit: 1 }))
          .toEqual(temporary.database.listRecentNotices({ sourceId: SOURCE.id, limit: 1 }));
        expect(reader.stats()).toEqual(temporary.database.stats());
        expect("ingestNotice" in reader).toBe(false);
        expect("persistRawDocument" in reader).toBe(false);
        expect("upsertSource" in reader).toBe(false);
      } finally {
        reader[Symbol.dispose]();
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("reads committed WAL content while the writer remains open", () => {
    const temporary = temporaryDatabase();
    try {
      ingestItem(temporary.database, SOURCE, "first", "2026-09-23");
      expect(existsSync(`${temporary.path}-wal`)).toBe(true);
      const reader = new InfoHubDatabaseReader(temporary.path);
      try {
        expect(reader.listRecentNotices().map((notice) => notice.sourceItemId))
          .toEqual(["first"]);
        ingestItem(temporary.database, SOURCE, "second", "2026-09-24");
        expect(reader.listRecentNotices().map((notice) => notice.sourceItemId))
          .toEqual(["second", "first"]);
      } finally {
        reader.close();
      }
    } finally {
      temporary.database.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing path without creating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-info-missing-"));
    const path = join(directory, "absent.sqlite");
    try {
      expect(() => new InfoHubDatabaseReader(path)).toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, DATABASE_SCHEMA_VERSION + 1])(
    "rejects schema version %i without changing the database",
    (version) => {
      const directory = mkdtempSync(join(tmpdir(), "nju-info-version-"));
      const path = join(directory, "version.sqlite");
      try {
        const database = new DatabaseSync(path);
        try {
          database.exec("CREATE TABLE sentinel (value TEXT)");
          database.prepare("INSERT INTO sentinel (value) VALUES (?)").run("preserved");
          database.exec(`PRAGMA user_version = ${version}`);
        } finally {
          database.close();
        }
        const before = readFileSync(path);
        expect(() => new InfoHubDatabaseReader(path)).toThrow(
          `unsupported database schema version ${version}; expected ${DATABASE_SCHEMA_VERSION}`,
        );
        expect(readFileSync(path)).toEqual(before);
        const inspection = new DatabaseSync(path, { readOnly: true });
        try {
          expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
          expect(inspection.prepare("SELECT value FROM sentinel").get())
            .toEqual({ value: "preserved" });
          expect(inspection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all())
            .toEqual([{ name: "sentinel" }]);
        } finally {
          inspection.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a populated v1 WAL database without migration and closes on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-info-reader-v1-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const database = new DatabaseSync(path);
      try {
        database.exec(readFileSync(new URL("../fixtures/schema-v1.sql", import.meta.url), "utf8"));
        database.prepare(
          `INSERT INTO sources (id, name, organization_id, organization_name,
             homepage_url, adapter_type, config_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(SOURCE.id, SOURCE.name, SOURCE.organization.id,
          SOURCE.organization.name, SOURCE.url, "webplus", JSON.stringify(SOURCE),
          1, "2026-09-23", "2026-09-23");
        database.exec("PRAGMA journal_mode = WAL");
        const before = database.prepare("SELECT * FROM sources").all();
        const columns = database.prepare("PRAGMA table_info(notice_revisions)").all();
        expect(() => new InfoHubDatabaseReader(path)).toThrow(
          `unsupported database schema version 1; expected ${DATABASE_SCHEMA_VERSION}`,
        );
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(database.prepare("SELECT * FROM sources").all()).toEqual(before);
        expect(database.prepare("PRAGMA table_info(notice_revisions)").all()).toEqual(columns);
        expect(columns).not.toContainEqual(expect.objectContaining({ name: "published_on" }));
      } finally {
        database.close();
      }
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
