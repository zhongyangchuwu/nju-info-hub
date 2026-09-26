import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SourceEntryQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { exportFeeds, type FeedExportReader } from "./export-feeds.js";

const sources: PersistedSourceSummary[] = [
  {
    id: "nju-cs-graduate",
    name: "Graduate notices",
    organization: { id: "nju-cs", name: "School of Computer Science" },
    url: "https://cs.nju.edu.cn/1703/list.htm",
  },
  {
    id: "nju-cs-seminars",
    name: "Seminars",
    organization: { id: "nju-cs", name: "School of Computer Science" },
    url: "https://cs.nju.edu.cn/1706/list.htm",
  },
  {
    id: "nju-cs-undergraduate",
    name: "Undergraduate notices",
    organization: { id: "nju-cs", name: "School of Computer Science" },
    url: "https://cs.nju.edu.cn/1704/list.htm",
  },
  {
    id: "nju-library",
    name: "Library notices",
    organization: { id: "nju-library", name: "University Library" },
    url: "https://lib.nju.edu.cn/notices/list.htm",
  },
  {
    id: "nju-math",
    name: "Mathematics notices",
    organization: { id: "nju-math", name: "School of Mathematics" },
    url: "https://math.nju.edu.cn/notices/list.htm",
  },
];

function currentNotice(source: PersistedSourceSummary, day: string): SourceEntryQueryResult {
  return {
    sourceId: source.id,
    sourceItemId: source.id + "-item",
    sourceName: source.name,
    organization: source.organization,
    noticeRevisionNumber: 1,
    observationRevisionNumber: 1,
    contentStatus: "full",
    acquisitionKind: "webplus-detail",
    url: source.url.replace("list.htm", "item/page.htm"),
    title: source.name + " item",
    publishedAtRaw: day,
    publishedOn: day,
    bodyText: source.name,
    bodyHtml: "<p>" + source.name + "</p>",
    attachments: [],
    provenance: { fetchedAt: "2026-09-24T01:00:00Z", contentSha256: "b".repeat(64) },
  };
}

describe("source catalog and source-set export", () => {
  it("derives catalog, OPML, and combined feeds from exactly the selected published sources", async () => {
    const entriesBySource = new Map<string, SourceEntryQueryResult[]>();
    sources.forEach((source, index) => {
      entriesBySource.set(source.id, [currentNotice(source, `2026-09-${String(23 - index).padStart(2, "0")}`)]);
    });
    const listRecentSourceEntries = vi.fn((options: { sourceId?: string } = {}) =>
      options.sourceId === undefined ? [] : (entriesBySource.get(options.sourceId) ?? []));
    const reader: FeedExportReader = {
      listSources: () => sources,
      listRecentSourceEntries,
    };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      mkdirSync(join(directory, "catalog"), { recursive: true });
      writeFileSync(join(directory, "catalog/index.html"), "workflow-restaged later");
      writeFileSync(join(directory, "catalog/sets.json"), "stale");
      await exportFeeds(reader, directory, sources.map((source) => source.id), {
        publicBaseUrl: "https://example.org/nju/",
        opmlPath: "subscriptions/cs.opml",
        sourceSet: {
          id: "cs",
          title: "Computer Science public information",
          sourceIds: [sources[2]!.id, sources[1]!.id, sources[0]!.id],
        },
      });
      expect(listRecentSourceEntries).toHaveBeenCalledTimes(sources.length);
      for (const source of sources) {
        expect(listRecentSourceEntries).toHaveBeenCalledWith({ sourceId: source.id, limit: 100 });
      }

      const catalog = JSON.parse(readFileSync(join(directory, "catalog/sources.json"), "utf8"));
      expect(catalog.sources.map((source: { id: string }) => source.id))
        .toEqual(sources.map((source) => source.id));
      expect(catalog.sources[0].feeds.rss)
        .toBe("https://example.org/nju/feeds/nju-cs-graduate.rss");
      const setCatalog = JSON.parse(readFileSync(join(directory, "catalog/sets.json"), "utf8"));
      expect(setCatalog).toEqual({
        version: 1,
        sets: [{
          id: "cs",
          title: "Computer Science public information",
          source_ids: [sources[0]!.id, sources[1]!.id, sources[2]!.id],
          subscriptions: { opml: "https://example.org/nju/subscriptions/cs.opml" },
          bundles: {
            json: "https://example.org/nju/bundles/cs.json",
            atom: "https://example.org/nju/bundles/cs.atom",
            rss: "https://example.org/nju/bundles/cs.rss",
          },
        }],
      });
      expect(readdirSync(join(directory, "catalog")).sort()).toEqual(["sets.json", "sources.json"]);

      const bundle = JSON.parse(readFileSync(join(directory, "bundles/cs.json"), "utf8"));
      expect(bundle.items.map((item: { id: string }) => item.id)).toEqual([
        "nju-cs-graduate:nju-cs-graduate-item",
        "nju-cs-seminars:nju-cs-seminars-item",
        "nju-cs-undergraduate:nju-cs-undergraduate-item",
      ]);
      expect(bundle._nju.source_set.source_ids).toEqual([sources[0]!.id, sources[1]!.id, sources[2]!.id]);
      expect(bundle.feed_url).toBe("https://example.org/nju/bundles/cs.json");

      const atom = readFileSync(join(directory, "bundles/cs.atom"), "utf8");
      const rss = readFileSync(join(directory, "bundles/cs.rss"), "utf8");
      const opml = readFileSync(join(directory, "subscriptions/cs.opml"), "utf8");
      expect((atom.match(/<entry>/g) ?? [])).toHaveLength(3);
      for (const source of sources.slice(0, 3)) {
        const itemId = source.id + ":" + source.id + "-item";
        expect(atom).toContain("<id>" + itemId + "</id>");
        expect(rss).toContain('<guid isPermaLink="false">' + itemId + "</guid>");
      }
      expect(opml).not.toContain("nju-library");
      expect(opml).not.toContain("nju-math");
      expect((rss.match(/<item>/g) ?? [])).toHaveLength(3);
      expect(atom).toContain('rel="self" type="application/atom+xml" href="https://example.org/nju/bundles/cs.atom"');
      expect(rss).toContain("<source url=");
      expect((opml.match(/<outline /g) ?? [])).toHaveLength(3);
      expect(opml).toContain("nju-cs-graduate.rss");
      expect(opml).toContain("nju-cs-seminars.rss");
      expect(opml).toContain("nju-cs-undergraduate.rss");
      expect(readdirSync(join(directory, "feeds")).sort()).toEqual(sources.flatMap((source) => [
        source.id + ".atom", source.id + ".json", source.id + ".rss",
      ]).sort());
      for (const source of sources) {
        const feed = JSON.parse(readFileSync(join(directory, "feeds", source.id + ".json"), "utf8"));
        expect(feed.items.map((item: { id: string }) => item.id)).toEqual([source.id + ":" + source.id + "-item"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a public base URL for source-set export before writing bundle output", async () => {
    const reader: FeedExportReader = {
      listSources: () => sources,
      listRecentSourceEntries: () => [],
    };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      await expect(exportFeeds(reader, directory, sources.map((source) => source.id), {
        sourceSet: { id: "cs", title: "CS", sourceIds: sources.map((source) => source.id) },
      })).rejects.toThrow("public base URL");
      expect(existsSync(join(directory, "bundles/cs.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes a default set OPML path and removes stale set catalog entries", async () => {
    const reader: FeedExportReader = { listSources: () => sources, listRecentSourceEntries: () => [] };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      const options = {
        publicBaseUrl: "https://example.org/nju",
        sourceSet: { id: "cs", title: "CS", sourceIds: sources.map((source) => source.id) },
      };
      await exportFeeds(reader, directory, sources.map((source) => source.id), options);
      expect(existsSync(join(directory, "subscriptions/cs.opml"))).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, "catalog/sets.json"), "utf8")).sets[0].subscriptions.opml)
        .toBe("https://example.org/nju/subscriptions/cs.opml");

      await exportFeeds(reader, directory, sources.map((source) => source.id), {
        publicBaseUrl: "https://example.org/nju",
      });
      expect(readdirSync(join(directory, "catalog"))).toEqual(["sources.json"]);
      expect(existsSync(join(directory, "bundles"))).toBe(false);
      expect(existsSync(join(directory, "subscriptions"))).toBe(false);

      await exportFeeds(reader, directory, sources.map((source) => source.id));
      expect(existsSync(join(directory, "catalog"))).toBe(false);
      expect(existsSync(join(directory, "bundles"))).toBe(false);
      expect(existsSync(join(directory, "subscriptions"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid source-set membership and IDs before replacing published output", async () => {
    const reader: FeedExportReader = { listSources: () => sources, listRecentSourceEntries: () => [] };
    const invalidCases = [
      [{ id: "cs", title: "CS", sourceIds: ["unpublished-source"] }, "unpublished source ID"],
      [{ id: "cs", title: "CS", sourceIds: [sources[0]!.id, sources[0]!.id] }, "duplicate source ID"],
      [{ id: "cs", title: "CS", sourceIds: [] }, "at least one source"],
      [{ id: "unsafe/id", title: "CS", sourceIds: [sources[0]!.id] }, "unsafe source set ID"],
    ] as const;

    for (const [sourceSet, error] of invalidCases) {
      const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
      const previousCatalog = "previous catalog";
      const previousFeed = "previous feed";
      const previousBundle = "previous bundle";
      const previousSetCatalog = "previous set catalog";
      try {
        mkdirSync(join(directory, "catalog"), { recursive: true });
        mkdirSync(join(directory, "feeds"), { recursive: true });
        mkdirSync(join(directory, "bundles"), { recursive: true });
        writeFileSync(join(directory, "catalog/sources.json"), previousCatalog);
        writeFileSync(join(directory, "catalog/sets.json"), previousSetCatalog);
        writeFileSync(join(directory, "feeds/previous.json"), previousFeed);
        writeFileSync(join(directory, "bundles/cs.json"), previousBundle);

        await expect(exportFeeds(reader, directory, sources.map((source) => source.id), {
          publicBaseUrl: "https://example.org/nju",
          sourceSet,
        })).rejects.toThrow(error);
        expect(readFileSync(join(directory, "catalog/sources.json"), "utf8")).toBe(previousCatalog);
        expect(readFileSync(join(directory, "catalog/sets.json"), "utf8")).toBe(previousSetCatalog);
        expect(readFileSync(join(directory, "feeds/previous.json"), "utf8")).toBe(previousFeed);
        expect(readFileSync(join(directory, "bundles/cs.json"), "utf8")).toBe(previousBundle);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects invalid set OPML paths before replacing published output", async () => {
    const reader: FeedExportReader = { listSources: () => sources, listRecentSourceEntries: () => [] };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    const previousCatalog = "previous catalog";
    const previousFeed = "previous feed";
    try {
      mkdirSync(join(directory, "catalog"), { recursive: true });
      mkdirSync(join(directory, "feeds"), { recursive: true });
      writeFileSync(join(directory, "catalog/sources.json"), previousCatalog);
      writeFileSync(join(directory, "feeds/previous.json"), previousFeed);
      await expect(exportFeeds(reader, directory, sources.map((source) => source.id), {
        publicBaseUrl: "https://example.org/nju",
        opmlPath: "../escape.opml",
        sourceSet: { id: "cs", title: "CS", sourceIds: sources.map((source) => source.id) },
      })).rejects.toThrow("unsafe OPML path");
      expect(readFileSync(join(directory, "catalog/sources.json"), "utf8")).toBe(previousCatalog);
      expect(readFileSync(join(directory, "feeds/previous.json"), "utf8")).toBe(previousFeed);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses an explicit publication item limit and rejects invalid limits", async () => {
    const listRecentSourceEntries = vi.fn(() => []);
    const reader: FeedExportReader = {
      listSources: () => sources.slice(0, 1),
      listRecentSourceEntries,
    };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      await exportFeeds(reader, directory, [sources[0]!.id], { itemLimit: 7 });
      expect(listRecentSourceEntries).toHaveBeenCalledWith({
        sourceId: sources[0]!.id,
        limit: 7,
      });

      await expect(exportFeeds(reader, directory, [sources[0]!.id], { itemLimit: 0 }))
        .rejects.toThrow("feed item limit");
      await expect(exportFeeds(reader, directory, [sources[0]!.id], { itemLimit: 101 }))
        .rejects.toThrow("feed item limit");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
