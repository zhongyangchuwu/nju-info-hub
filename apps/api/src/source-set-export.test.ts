import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
