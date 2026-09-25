import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      expect(serialized).toBe(`${JSON.stringify(buildJsonFeed(source, reader.listRecentSourceEntries({
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
      expect(readdirSync(join(outputDirectory, "feeds"))).toEqual([
        `${GRADUATE_SOURCE.id}.atom`, `${GRADUATE_SOURCE.id}.json`, `${GRADUATE_SOURCE.id}.rss`,
      ]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades an observed link to full content without changing its exported ID", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "upgrade.sqlite");
    const outputDirectory = join(directory, "published");
    const writer = new InfoHubDatabase(databasePath);
    const reader = new InfoHubDatabaseReader(databasePath);
    const itemId = "grad-upgrade";
    const url = `https://cs.nju.edu.cn/notices/${itemId}.htm`;
    const body = `<li><a href="${url}">Official title</a><span>2026-09-23</span></li>`;
    const listRaw = {
      sourceId: GRADUATE_SOURCE.id,
      url: GRADUATE_SOURCE.url,
      fetchedAt: "2026-09-23T10:00:00.000Z",
      contentType: "text/html",
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    try {
      writer.observeSourceItem(GRADUATE_SOURCE, listRaw, {
        sourceId: GRADUATE_SOURCE.id,
        sourceItemId: itemId,
        url,
        acquisitionKind: "webplus-detail",
        title: "Official title",
        publishedAtRaw: "2026-09-23",
      });
      expect(reader.listRecentNotices()).toEqual([]);
      await exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id]);
      const feedPath = join(outputDirectory, "feeds", `${GRADUATE_SOURCE.id}.json`);
      const initial = JSON.parse(readFileSync(feedPath, "utf8")).items[0];
      expect(initial).toMatchObject({
        id: `${GRADUATE_SOURCE.id}:${itemId}`,
        title: "Official title",
        url,
        _nju: { content_status: "link-only", fetched_at: listRaw.fetchedAt, content_sha256: listRaw.sha256 },
      });
      expect(initial).not.toHaveProperty("content_html");

      ingestNotice(writer, GRADUATE_SOURCE, itemId);
      await exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id]);
      const upgraded = JSON.parse(readFileSync(feedPath, "utf8")).items[0];
      expect(upgraded.id).toBe(initial.id);
      expect(upgraded).toMatchObject({
        url,
        content_text: `${itemId} details`,
        _nju: { content_status: "full", revision_number: 1, observation_revision_number: 1 },
      });
      expect(upgraded.content_html).toBe(`<p>${itemId} details</p>`);
      expect(reader.listRecentNotices()).toHaveLength(1);
      expect(reader.listRecentSourceEntries()).toHaveLength(1);
    } finally {
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces only the feeds directory on allow-listed export", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "published");
    const feedsDirectory = join(outputDirectory, "feeds");
    const siblingFile = join(outputDirectory, "index.html");
    mkdirSync(feedsDirectory, { recursive: true });
    writeFileSync(join(feedsDirectory, "stale.json"), "stale");
    writeFileSync(siblingFile, "keep this page");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id]);
      expect(readdirSync(feedsDirectory)).toEqual([
        `${GRADUATE_SOURCE.id}.atom`, `${GRADUATE_SOURCE.id}.json`, `${GRADUATE_SOURCE.id}.rss`,
      ]);
      expect(JSON.parse(readFileSync(join(feedsDirectory, `${GRADUATE_SOURCE.id}.json`), "utf8")).items)
        .toHaveLength(1);
      expect(readFileSync(siblingFile, "utf8")).toBe("keep this page");
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
        `${GRADUATE_SOURCE.id}.atom`, `${GRADUATE_SOURCE.id}.json`, `${GRADUATE_SOURCE.id}.rss`,
        `${SEMINAR_SOURCE.id}.atom`, `${SEMINAR_SOURCE.id}.json`, `${SEMINAR_SOURCE.id}.rss`,
      ]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown IDs without replacing existing feeds", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "published");
    const feedsDirectory = join(outputDirectory, "feeds");
    mkdirSync(feedsDirectory, { recursive: true });
    writeFileSync(join(feedsDirectory, "previous.json"), "previous");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await expect(exportFeeds(reader, outputDirectory, ["unknown-source"]))
        .rejects.toThrow("unknown source ID: unknown-source");
      expect(readFileSync(join(feedsDirectory, "previous.json"), "utf8")).toBe("previous");
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
        listRecentSourceEntries: () => [],
      };
      await expect(exportFeeds(unsafeReader, outputDirectory))
        .rejects.toThrow("unsafe source ID");
      expect(existsSync(outputDirectory)).toBe(false);
      await expect(exportFeeds(unsafeReader, outputDirectory, [GRADUATE_SOURCE.id]))
        .rejects.toThrow("unsafe source ID");
      expect(existsSync(outputDirectory)).toBe(false);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes only selected sources to OPML in persisted order with absolute RSS subscriptions", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "published");
    const reader = new InfoHubDatabaseReader(database);
    try {
      await exportFeeds(reader, outputDirectory, [SEMINAR_SOURCE.id, GRADUATE_SOURCE.id], {
        publicBaseUrl: "https://example.org/pilot", opmlPath: "subscriptions/cs.opml",
      });
      const opml = readFileSync(join(outputDirectory, "subscriptions/cs.opml"), "utf8");
      expect(opml).toContain('<opml version="2.0">');
      expect(opml.match(/<outline /g)).toHaveLength(2);
      expect(opml.indexOf("nju-cs-graduate.rss")).toBeLessThan(opml.indexOf("nju-cs-seminars.rss"));
      expect(opml).toContain('text="School of Computer Science — Graduate notices" title="School of Computer Science — Graduate notices" type="rss"');
      expect(opml).toContain('xmlUrl="https://example.org/pilot/feeds/nju-cs-graduate.rss" htmlUrl="https://cs.nju.edu.cn/graduate/list.htm"');
      const json = JSON.parse(readFileSync(join(outputDirectory, "feeds/nju-cs-graduate.json"), "utf8"));
      expect(json.feed_url).toBe("https://example.org/pilot/feeds/nju-cs-graduate.json");
      expect(readFileSync(join(outputDirectory, "feeds/nju-cs-graduate.atom"), "utf8"))
        .toContain('rel="self" type="application/atom+xml" href="https://example.org/pilot/feeds/nju-cs-graduate.atom"');
      expect(readFileSync(join(outputDirectory, "feeds/nju-cs-graduate.rss"), "utf8")).not.toContain("<enclosure");
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("escapes OPML metadata and retains only requested IDs", async () => {
    const directory = temporaryDirectory();
    const outputDirectory = join(directory, "published");
    const special = { ...GRADUATE_SOURCE, name: '通知 & <新> "甲"',
      organization: { id: "nju-cs", name: '学院 & "乙"' },
      url: "https://cs.nju.edu.cn/list.htm?x=1&y=2" };
    const reader: FeedExportReader = {
      listSources: () => [{ id: special.id, name: special.name, organization: special.organization,
        url: special.url },
      { id: SEMINAR_SOURCE.id, name: SEMINAR_SOURCE.name, organization: SEMINAR_SOURCE.organization,
        url: SEMINAR_SOURCE.url }],
      listRecentSourceEntries: () => [],
    };
    try {
      await exportFeeds(reader, outputDirectory, [special.id], {
        publicBaseUrl: "https://example.org/", opmlPath: "subscriptions/cs.opml",
      });
      const opml = readFileSync(join(outputDirectory, "subscriptions/cs.opml"), "utf8");
      expect(opml.match(/<outline /g)).toHaveLength(1);
      expect(opml).toContain('text="学院 &amp; &quot;乙&quot; — 通知 &amp; &lt;新&gt; &quot;甲&quot;"');
      expect(opml).toContain('htmlUrl="https://cs.nju.edu.cn/list.htm?x=1&amp;y=2"');
      expect(opml).not.toContain("nju-cs-seminars.rss");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails unsafe OPML paths and invalid base URLs before replacing existing feeds", async () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "published");
    mkdirSync(join(outputDirectory, "feeds"), { recursive: true });
    writeFileSync(join(outputDirectory, "feeds/previous.json"), "previous");
    const reader = new InfoHubDatabaseReader(database);
    try {
      const invalid = [
        { opmlPath: "subscriptions/cs.opml" },
        ...["relative", "file:///tmp/evil", "ftp://example.org/", "https://user:pass@example.org/",
          "https://example.org/?x=1", "https://example.org/#a"].map((publicBaseUrl) =>
          ({ publicBaseUrl, opmlPath: "subscriptions/cs.opml" })),
        ...["../escape.opml", "/tmp/escape.opml", "subscriptions/../../escape.opml", "feeds/cs.opml",
          "subscriptions\\escape.opml", "subscriptions//cs.opml", ""].map((opmlPath) =>
          ({ publicBaseUrl: "https://example.org/", opmlPath })),
      ];
      for (const options of invalid) {
        await expect(exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id], options)).rejects.toThrow();
        expect(readFileSync(join(outputDirectory, "feeds/previous.json"), "utf8")).toBe("previous");
      }
      symlinkSync(directory, join(outputDirectory, "subscriptions"));
      await expect(exportFeeds(reader, outputDirectory, [GRADUATE_SOURCE.id], {
        publicBaseUrl: "https://example.org/", opmlPath: "subscriptions/cs.opml",
      })).rejects.toThrow("symbolic link");
      expect(readFileSync(join(outputDirectory, "feeds/previous.json"), "utf8")).toBe("previous");
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts legacy positional CLI and explicit base URL/OPML flags", () => {
    const directory = temporaryDirectory();
    const database = createPersistedDatabase(directory);
    const outputDirectory = join(directory, "published");
    const invoke = (...args: string[]) => spawnSync("pnpm", ["--filter", "@nju-info/api", "export-feeds", "--",
      database, outputDirectory, ...args], { cwd: join(process.cwd(), "../.."), encoding: "utf8" });
    try {
      const legacy = invoke(GRADUATE_SOURCE.id);
      expect(legacy.status, legacy.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(outputDirectory, "feeds/nju-cs-graduate.json"), "utf8")))
        .not.toHaveProperty("feed_url");
      expect(existsSync(join(outputDirectory, "subscriptions/cs.opml"))).toBe(false);
      const flagged = invoke(GRADUATE_SOURCE.id, "--base-url", "https://example.org/pilot/", "--opml", "subscriptions/cs.opml");
      expect(flagged.status, flagged.stderr).toBe(0);
      expect(readFileSync(join(outputDirectory, "subscriptions/cs.opml"), "utf8"))
        .toContain("https://example.org/pilot/feeds/nju-cs-graduate.rss");
      for (const args of [["--opml", "subscriptions/cs.opml"], ["--base-url"], ["--bogus", "x"],
        ["--base-url", "https://example.org", "--base-url", "https://example.org"]]) {
        expect(invoke(...args).status).not.toBe(0);
        expect(readFileSync(join(outputDirectory, "subscriptions/cs.opml"), "utf8"))
          .toContain("https://example.org/pilot/feeds/nju-cs-graduate.rss");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("separates five published sources from an explicit three-source CLI set", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "five-sources.sqlite");
    const outputDirectory = join(directory, "published");
    const internalSource: Source = { ...GRADUATE_SOURCE, id: "nju-cs-internal-notices", name: "Internal notices" };
    const otherOne: Source = { ...GRADUATE_SOURCE, id: "nju-library-news", name: "Library news", organization: { id: "nju-library", name: "Library" } };
    const otherTwo: Source = { ...GRADUATE_SOURCE, id: "nju-science-news", name: "Science news", organization: { id: "nju-science", name: "Science" } };
    const sources = [otherOne, GRADUATE_SOURCE, otherTwo, internalSource, SEMINAR_SOURCE];
    const database = new InfoHubDatabase(databasePath);
    for (const source of sources) {
      database.upsertSource(source);
      ingestNotice(database, source, `${source.id}-item`);
    }
    database.close();

    const invoke = (...args: string[]) => spawnSync("pnpm", ["--filter", "@nju-info/api", "export-feeds", "--",
      databasePath, outputDirectory, ...args], { cwd: join(process.cwd(), "../.."), encoding: "utf8" });
    const publishedIds = sources.map((source) => source.id).sort();
    const setFlags = ["--set-id", "cs", "--set-title", "Computer Science", "--set-source", SEMINAR_SOURCE.id,
      "--set-source", internalSource.id, "--set-source", GRADUATE_SOURCE.id];
    try {
      const result = invoke(...publishedIds, "--base-url", "https://example.org/", "--opml", "subscriptions/cs.opml", ...setFlags);
      expect(result.status, result.stderr).toBe(0);

      const sourceCatalog = JSON.parse(readFileSync(join(outputDirectory, "catalog/sources.json"), "utf8"));
      expect(sourceCatalog.sources.map((source: { id: string }) => source.id)).toEqual(publishedIds);
      const setCatalog = JSON.parse(readFileSync(join(outputDirectory, "catalog/sets.json"), "utf8"));
      expect(setCatalog.sets[0].source_ids).toEqual([GRADUATE_SOURCE.id, internalSource.id, SEMINAR_SOURCE.id]);
      expect(readdirSync(join(outputDirectory, "feeds")).sort()).toEqual(
        publishedIds.flatMap((id) => [`${id}.atom`, `${id}.json`, `${id}.rss`]).sort());

      const opml = readFileSync(join(outputDirectory, "subscriptions/cs.opml"), "utf8");
      expect(opml.match(/<outline /g)).toHaveLength(3);
      expect(opml).toContain("nju-cs-graduate.rss");
      expect(opml).toContain("nju-cs-internal-notices.rss");
      expect(opml).toContain("nju-cs-seminars.rss");
      expect(opml).not.toContain("nju-library-news.rss");
      expect(opml).not.toContain("nju-science-news.rss");

      const bundle = JSON.parse(readFileSync(join(outputDirectory, "bundles/cs.json"), "utf8"));
      expect(bundle._nju.source_set.source_ids).toEqual([GRADUATE_SOURCE.id, internalSource.id, SEMINAR_SOURCE.id]);
      expect(bundle.items.map((item: { _nju: { source_id: string } }) => item._nju.source_id).sort())
        .toEqual([GRADUATE_SOURCE.id, internalSource.id, SEMINAR_SOURCE.id].sort());

      const markerPath = join(outputDirectory, "feeds/previous.json");
      writeFileSync(markerPath, "previous");
      const invalidSets: { args: string[]; error: string }[] = [
        {
          args: ["--set-id", "cs", "--set-title", "Computer Science", "--set-source", GRADUATE_SOURCE.id,
            "--set-source", GRADUATE_SOURCE.id],
          error: "duplicate source ID in source set",
        },
        {
          args: ["--set-id", "cs", "--set-title", "Computer Science", "--set-source", "nju-cs-unpublished"],
          error: "source set contains unpublished source ID",
        },
      ];
      for (const invalidSet of invalidSets) {
        const invalid = invoke(...publishedIds, "--base-url", "https://example.org/", ...invalidSet.args);
        expect(invalid.status).not.toBe(0);
        expect(invalid.stderr).toContain(invalidSet.error);
        expect(readFileSync(markerPath, "utf8")).toBe("previous");
      }

      for (const incomplete of [
        ["--set-id", "cs"],
        ["--set-title", "Computer Science"],
        ["--set-source", GRADUATE_SOURCE.id],
        ["--set-id", "cs", "--set-title", "Computer Science"],
        ["--set-id", "cs", "--set-source", GRADUATE_SOURCE.id],
        ["--set-title", "Computer Science", "--set-source", GRADUATE_SOURCE.id],
      ]) {
        const invalid = invoke(...publishedIds, ...incomplete);
        expect(invalid.status).not.toBe(0);
        expect(invalid.stderr).toContain("at least one --set-source");
        expect(readFileSync(markerPath, "utf8")).toBe("previous");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
