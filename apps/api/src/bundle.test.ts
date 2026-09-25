import { describe, expect, it } from "vitest";
import type { SourceEntryQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { buildAtomBundle, buildJsonBundle, buildRssBundle } from "./bundle.js";
import { resolveSourceSet } from "./source-set.js";

const graduate: PersistedSourceSummary = {
  id: "nju-cs-graduate",
  name: "Graduate notices",
  organization: { id: "nju-cs", name: "School of Computer Science" },
  url: "https://cs.nju.edu.cn/1703/list.htm",
  enabled: true,
};

const seminars: PersistedSourceSummary = {
  id: "nju-cs-seminars",
  name: "Seminars",
  organization: graduate.organization,
  url: "https://cs.nju.edu.cn/1706/list.htm",
  enabled: true,
};

function notice(
  source: PersistedSourceSummary,
  itemId: string,
  publishedOn: string | null,
  fetchedAt: string,
  attachments: SourceEntryQueryResult["attachments"] = [],
): SourceEntryQueryResult {
  return {
    sourceId: source.id,
    sourceItemId: itemId,
    sourceName: source.name,
    organization: source.organization,
    noticeRevisionNumber: 1,
    observationRevisionNumber: 1,
    contentStatus: "full",
    acquisitionKind: "webplus-detail",
    url: "https://cs.nju.edu.cn/" + itemId + "/page.htm",
    title: itemId + " title",
    publishedAtRaw: publishedOn,
    publishedOn,
    bodyText: itemId + " body",
    bodyHtml: "<p>" + itemId + " body</p>",
    attachments,
    provenance: { fetchedAt, contentSha256: "a".repeat(64) },
  };
}

describe("combined source-set feeds", () => {
  const set = resolveSourceSet({
    id: "cs",
    title: "Computer Science public information",
    sourceIds: [graduate.id, seminars.id],
  }, [graduate, seminars]);
  const graduateDated = notice(graduate, "grad-a", "2026-09-22", "2026-09-24T01:00:00Z");
  const graduateUndated = notice(graduate, "grad-undated", null, "2026-09-24T02:00:00Z");
  const graduateLinkOnly: SourceEntryQueryResult = {
    ...notice(graduate, "grad-link/only:2026", "2026-09-24", "2026-09-24T05:00:00Z"),
    contentStatus: "link-only",
    acquisitionKind: "public-wechat",
    noticeRevisionNumber: null,
    observationRevisionNumber: 3,
    bodyText: "",
    bodyHtml: "",
    attachments: [],
  };
  const seminarNewest = notice(seminars, "seminar-new", "2026-09-23", "2026-09-24T03:00:00Z", [
    { url: "https://cs.nju.edu.cn/a.pdf", title: "A.pdf", mediaType: "application/pdf" },
  ]);
  const seminarTie = notice(seminars, "seminar-tie", "2026-09-22", "2026-09-24T04:00:00Z");
  const parts = [
    { source: graduate, entries: [graduateDated, graduateUndated, graduateLinkOnly] },
    { source: seminars, entries: [seminarNewest, seminarTie] },
  ];

  it("orders mixed entries across sources while preserving identity and original links", () => {
    const feed = buildJsonBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.json",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(feed.items.map((item) => item.id)).toEqual([
      "nju-cs-graduate:grad-link%2Fonly%3A2026",
      "nju-cs-seminars:seminar-new",
      "nju-cs-graduate:grad-a",
      "nju-cs-seminars:seminar-tie",
      "nju-cs-graduate:grad-undated",
    ]);
    expect(feed.items[0]).toMatchObject({
      url: graduateLinkOnly.url,
      title: "grad-link/only:2026 title",
      content_text: "Full text is unavailable from the public collector; open the original item.",
      _nju: {
        source_id: graduate.id,
        source_name: graduate.name,
        organization: graduate.organization,
        content_status: "link-only",
        observation_revision_number: 3,
      },
    });
    expect(feed.items[0]).not.toHaveProperty("content_html");
    expect(feed.items[0]).not.toHaveProperty("attachments");
    expect(feed.items[0]?._nju).not.toHaveProperty("revision_number");
    expect(feed.items[0]?._nju).toHaveProperty("acquisition_kind", "public-wechat");
    expect(feed.items[1]).toMatchObject({
      url: seminarNewest.url,
      attachments: [{ url: "https://cs.nju.edu.cn/a.pdf", mime_type: "application/pdf", title: "A.pdf" }],
      _nju: { source_id: seminars.id, source_name: seminars.name, organization: seminars.organization },
    });
    expect(feed._nju.source_set).toEqual({
      id: "cs",
      title: "Computer Science public information",
      source_ids: [graduate.id, seminars.id],
    });
  });

  it("uses standard Atom and RSS attribution while preserving link-only notes", () => {
    const atom = buildAtomBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.atom",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(atom).toContain("<source>");
    expect(atom).toContain("<title>School of Computer Science — Seminars</title>");
    expect(atom).toContain('<link rel="alternate" href="https://cs.nju.edu.cn/1706/list.htm"/>');
    expect(atom).toContain('<link rel="enclosure" href="https://cs.nju.edu.cn/a.pdf" type="application/pdf" title="A.pdf"/>');
    expect(atom).toContain('<content type="text">Full text is unavailable from the public collector; open the original item.</content>');
    expect(atom).toContain("<nju:content_status>link-only</nju:content_status>");
    expect(atom).toContain("<nju:acquisition_kind>public-wechat</nju:acquisition_kind>");
    expect(atom).not.toContain('<content type="html">Full text is unavailable');
    const linkAtomEntry = atom.slice(atom.lastIndexOf("<entry>", atom.indexOf("grad-link%2Fonly%3A2026")),
      atom.indexOf("</entry>", atom.indexOf("grad-link%2Fonly%3A2026")) + "</entry>".length);
    expect(linkAtomEntry).not.toContain('rel="enclosure"');

    const rss = buildRssBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.rss",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(rss).toContain('<source url="https://cs.nju.edu.cn/1703/list.htm">School of Computer Science — Graduate notices</source>');
    expect(rss).toContain('<source url="https://cs.nju.edu.cn/1706/list.htm">School of Computer Science — Seminars</source>');
    expect(rss).not.toContain("<enclosure");
    expect(rss).toContain("Full text is unavailable from the public collector; open the original item.");
    expect(rss).toContain("<nju:content_status>link-only</nju:content_status>");
    expect(rss).toContain("<nju:content_sha256>" + "a".repeat(64) + "</nju:content_sha256>");
  });
});
