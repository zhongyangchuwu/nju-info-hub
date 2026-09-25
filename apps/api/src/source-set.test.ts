import { describe, expect, it } from "vitest";
import type { PersistedSourceSummary } from "@nju-info/db";
import { buildSourceCatalog, bundleSelfUrl, resolveSourceSet } from "./source-set.js";

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
];

describe("published source sets", () => {
  it("resolves selected IDs in deterministic published-source order", () => {
    const set = resolveSourceSet({
      id: "cs",
      title: "  Computer Science  ",
      sourceIds: ["nju-cs-seminars", "nju-cs-graduate"],
    }, sources);
    expect(set).toMatchObject({
      id: "cs",
      title: "Computer Science",
      sourceIds: ["nju-cs-graduate", "nju-cs-seminars"],
    });
    expect(set.sources.map((source) => source.id)).toEqual(["nju-cs-graduate", "nju-cs-seminars"]);
  });

  it("rejects unsafe, duplicate, empty, and unpublished selections", () => {
    expect(() => resolveSourceSet({ id: "../cs", title: "CS", sourceIds: [sources[0]!.id] }, sources))
      .toThrow("unsafe source set ID");
    expect(() => resolveSourceSet({ id: "cs", title: " ", sourceIds: [sources[0]!.id] }, sources))
      .toThrow("title");
    expect(() => resolveSourceSet({ id: "cs", title: "CS", sourceIds: [] }, sources))
      .toThrow("at least one source");
    expect(() => resolveSourceSet({
      id: "cs", title: "CS", sourceIds: [sources[0]!.id, sources[0]!.id],
    }, sources)).toThrow("duplicate source ID");
    expect(() => resolveSourceSet({
      id: "cs", title: "CS", sourceIds: ["unknown-source"],
    }, sources)).toThrow("unpublished source ID");
  });

  it("builds a deterministic public source catalog without collector details", () => {
    const base = new URL("https://example.org/nju-info-hub/");
    expect(buildSourceCatalog(sources, base)).toEqual({
      version: 1,
      sources: [
        {
          id: "nju-cs-graduate",
          name: "Graduate notices",
          organization: sources[0]!.organization,
          home_page_url: sources[0]!.url,
          feeds: {
            json: "https://example.org/nju-info-hub/feeds/nju-cs-graduate.json",
            atom: "https://example.org/nju-info-hub/feeds/nju-cs-graduate.atom",
            rss: "https://example.org/nju-info-hub/feeds/nju-cs-graduate.rss",
          },
        },
        {
          id: "nju-cs-seminars",
          name: "Seminars",
          organization: sources[1]!.organization,
          home_page_url: sources[1]!.url,
          feeds: {
            json: "https://example.org/nju-info-hub/feeds/nju-cs-seminars.json",
            atom: "https://example.org/nju-info-hub/feeds/nju-cs-seminars.atom",
            rss: "https://example.org/nju-info-hub/feeds/nju-cs-seminars.rss",
          },
        },
      ],
    });
    expect(bundleSelfUrl(base, "cs", "json"))
      .toBe("https://example.org/nju-info-hub/bundles/cs.json");
  });
});
