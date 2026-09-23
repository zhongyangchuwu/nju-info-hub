import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfoHubDatabase, InfoHubDatabaseReader } from "@nju-info/db";
import { describe, expect, it } from "vitest";
import { buildJsonFeed } from "./feed.js";
import { exportFeeds, type FeedExportReader } from "./export-feeds.js";

type Source = Parameters<InfoHubDatabase["upsertSource"]>[0];
type RawDocument = Parameters<InfoHubDatabase["ingestNotice"]>[1];
type ParsedNotice = Parameters<InfoHubDatabase["ingestNotice"]>[2];

const GRADUATE_SOURCE: Source = {
  schemaVersion: 1,
  id: "nju-cs-graduate",
  name: "Graduate notices",
  organization: { id: "nju-cs", name: "School of Computer Science" },
  url: "https://cs.nju.edu.cn/graduate/list.htm",
  audience: ["students"],
  categories: ["notices"],
  enabled: true,
  adapter: { type: "webplus" },
};

const SEMINAR_SOURCE: Source = {
  ...GRADUATE_SOURCE,
  id: "nju-cs-seminars",
  name: "Seminars",
  url: "https://cs.nju.edu.cn/seminar/list.htm",
};

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "nju-info-feed-export-"));
}

function ingestNotice(database: InfoHubDatabase, source: Source, itemId: string): void {
  const body = `<p>${itemId} details</p>`;
  const raw: RawDocument = {
    sourceId: source.id,
    url: `https://cs.nju.edu.cn/notices/${itemId}.htm`,
    fetchedAt: "2026-09-23T11:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  const notice: ParsedNotice = {
    sourceId: source.id,
    sourceItemId: itemId,
    url: `https://cs.nju.edu.cn/notices/${itemId}.htm`,
    title: `${itemId} title`,
    publishedAtRaw: "2026年9月23日",
    publishedOn: "2026-09-23",
    bodyText: `${itemId} details`,
    bodyHtml: body,
    attachments: [
      { url: `https://cs.nju.edu.cn/files/${itemId}.pdf`, title: `${itemId}.pdf`, mediaType: "application/pdf" },
      { url: `https://cs.nju.edu.cn/files/${itemId}.bin`, title: `${itemId} data` },
    ],
    provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
  };
  database.ingestNotice(source, raw, notice);
}

function createPersistedDatabase(directory: string, graduateItems = 1): string {
  const path = join(directory, "test.sqlite");
  const database = new InfoHubDatabase(path);
  database.upsertSource(GRADUATE_SOURCE);
  database.upsertSource(SEMINAR_SOURCE);
  ingestNotice(database, GRADUATE_SOURCE, "grad-123");
  for (let index = 1; index < graduateItems; index++) {
    ingestNotice(database, GRADUATE_SOURCE, `grad-${index + 199}`);
  }
  ingestNotice(database, SEMINAR_SOURCE, "seminar-456");
  database.close();
  return path;
}

describe("static JSON Feed exporter", () => {
  it("writes the selected persisted feed with the same semantics as the API builder", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory, 51);
    const outputDirectory = join(directory, "published");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id]);
      const serialized = readFileSync(join(outputDirectory, "feeds", `${GRADUATE_SOURCE.id}.json`), "utf8");
      const feed = JSON.parse(serialized);
      const source = reader.listSources().find((candidate) => candidate.id === GRADUATE_SOURCE.id);
      if (!source) throw new Error("persisted source missing from test database");
      expect(serialized.endsWith("\n")).toBe(true);
      expect(serialized).toBe(`${JSON.stringify(buildJsonFeed(source, reader.listRecentNotices({
        sourceId: source.id,
        limit: 100,
      })), null, 2)}\n`);
      expect(feed.items[0]).toMatchObject({
        id: "nju-cs-graduate:grad-123",
        url: "https://cs.nju.edu.cn/notices/grad-123.htm",
        date_published: "2026-09-23T00:00:00+08:00",
        attachments: [
          { url: "https://cs.nju.edu.cn/files/grad-123.pdf", mime_type: "application/pdf" },
          { url: "https://cs.nju.edu.cn/files/grad-123.bin", mime_type: "application/octet-stream" },
        ],
        _nju: {
          source_id: GRADUATE_SOURCE.id,
          organization: GRADUATE_SOURCE.organization,
          published_on: "2026-09-23",
          date_precision: "day",
        },
      });
      expect(feed.items).toHaveLength(51);
      expect(readdirSync(join(outputDirectory, "feeds"))).toEqual([`${GRADUATE_SOURCE.id}.json`]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports all persisted sources by default", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = directory;
    const reader = new InfoHubDatabaseReader(database);
    try {
      await exportFeeds(reader, outputDirectory);
      expect(readdirSync(join(outputDirectory, "feeds")).sort()).toEqual([
        `${GRADUATE_SOURCE.id}.json`,
        `${SEMINAR_SOURCE.id}.json`,
      ]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown IDs before creating the output directory", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "not-created");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await expect(exportFeeds(reader, outputDirectory, ["unknown-source"]))
        .rejects.toThrow("unknown source ID: unknown-source");
      expect(existsSync(outputDirectory)).toBe(false);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe requested and persisted IDs before creating output", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "not-created");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await expect(exportFeeds(reader, outputDirectory, ["../outside"]))
        .rejects.toThrow("unsafe source ID");
      expect(existsSync(outputDirectory)).toBe(false);

      const unsafeReader: FeedExportReader = {
        listSources: () => [{
          ...reader.listSources()[0]!,
          id: "../outside",
        }],
        listRecentNotices: () => [],
      };
      await expect(exportFeeds(unsafeReader, outputDirectory))
        .rejects.toThrow("unsafe source ID");
      expect(existsSync(outputDirectory)).toBe(false);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
