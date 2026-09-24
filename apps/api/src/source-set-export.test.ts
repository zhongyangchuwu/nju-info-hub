import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { exportFeeds, type FeedExportReader } from "./export-feeds.js";

const sources: PersistedSourceSummary[] = [
  {
    id: "nju-cs-graduate",
    name: "Graduate notices",
    organization: { id: "nju-cs", name: "School of Computer Science" },
    url: "https://cs.nju.edu.cn/1703/list.htm",
    enabled: true,
  },
  {
    id: "nju-cs-seminars",
    name: "Seminars",
    organization: { id: "nju-cs", name: "School of Computer Science" },
    url: "https://cs.nju.edu.cn/1706/list.htm",
    enabled: true,
  },
];

function currentNotice(source: PersistedSourceSummary, day: string): NoticeQueryResult {
  return {
    sourceId: source.id,
    sourceItemId: source.id + "-item",
    sourceName: source.name,
    organization: source.organization,
    revisionNumber: 1,
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
    const notices = new Map([
      [sources[0]!.id, [currentNotice(sources[0]!, "2026-09-23")]],
      [sources[1]!.id, [currentNotice(sources[1]!, "2026-09-22")]],
    ]);
    const reader: FeedExportReader = {
      listSources: () => sources,
      listRecentNotices: (options = {}) => {
        const sourceId = options.sourceId;
        return sourceId === undefined ? [] : (notices.get(sourceId) ?? []);
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      mkdirSync(join(directory, "catalog"), { recursive: true });
      writeFileSync(join(directory, "catalog/index.html"), "workflow-restaged later");
      writeFileSync(join(directory, "catalog/sets.json"), "stale");
      await exportFeeds(reader, directory, [sources[0]!.id, sources[1]!.id], {
        publicBaseUrl: "https://example.org/nju/",
        opmlPath: "subscriptions/cs.opml",
        sourceSet: { id: "cs", title: "Computer Science public information" },
      });

      const catalog = JSON.parse(readFileSync(join(directory, "catalog/sources.json"), "utf8"));
      expect(catalog.sources.map((source: { id: string }) => source.id))
        .toEqual([sources[0]!.id, sources[1]!.id]);
      expect(catalog.sources[0].feeds.rss)
        .toBe("https://example.org/nju/feeds/nju-cs-graduate.rss");
      const setCatalog = JSON.parse(readFileSync(join(directory, "catalog/sets.json"), "utf8"));
      expect(setCatalog).toEqual({
        version: 1,
        sets: [{
          id: "cs",
          title: "Computer Science public information",
          source_ids: [sources[0]!.id, sources[1]!.id],
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
      ]);
      expect(bundle.feed_url).toBe("https://example.org/nju/bundles/cs.json");

      const atom = readFileSync(join(directory, "bundles/cs.atom"), "utf8");
      const rss = readFileSync(join(directory, "bundles/cs.rss"), "utf8");
      const opml = readFileSync(join(directory, "subscriptions/cs.opml"), "utf8");
      expect(atom).toContain('rel="self" type="application/atom+xml" href="https://example.org/nju/bundles/cs.atom"');
      expect(rss).toContain("<source url=");
      expect((opml.match(/<outline /g) ?? [])).toHaveLength(2);
      expect(opml).toContain("nju-cs-graduate.rss");
      expect(opml).toContain("nju-cs-seminars.rss");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a public base URL for source-set export before writing bundle output", async () => {
    const reader: FeedExportReader = {
      listSources: () => sources,
      listRecentNotices: () => [],
    };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      await expect(exportFeeds(reader, directory, sources.map((source) => source.id), {
        sourceSet: { id: "cs", title: "CS" },
      })).rejects.toThrow("public base URL");
      expect(existsSync(join(directory, "bundles/cs.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes a default set OPML path and removes stale set catalog entries", async () => {
    const reader: FeedExportReader = { listSources: () => sources, listRecentNotices: () => [] };
    const directory = mkdtempSync(join(tmpdir(), "nju-info-source-set-"));
    try {
      const options = { publicBaseUrl: "https://example.org/nju", sourceSet: { id: "cs", title: "CS" } };
      await exportFeeds(reader, directory, sources.map((source) => source.id), options);
      expect(existsSync(join(directory, "subscriptions/cs.opml"))).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, "catalog/sets.json"), "utf8")).sets[0].subscriptions.opml)
        .toBe("https://example.org/nju/subscriptions/cs.opml");

      await exportFeeds(reader, directory, sources.map((source) => source.id), {
        publicBaseUrl: "https://example.org/nju",
      });
      expect(readdirSync(join(directory, "catalog"))).toEqual(["sources.json"]);
      await exportFeeds(reader, directory, sources.map((source) => source.id));
      expect(existsSync(join(directory, "catalog"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid set OPML paths before replacing published output", async () => {
    const reader: FeedExportReader = { listSources: () => sources, listRecentNotices: () => [] };
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
        sourceSet: { id: "cs", title: "CS" },
      })).rejects.toThrow("unsafe OPML path");
      expect(readFileSync(join(directory, "catalog/sources.json"), "utf8")).toBe(previousCatalog);
      expect(readFileSync(join(directory, "feeds/previous.json"), "utf8")).toBe(previousFeed);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
