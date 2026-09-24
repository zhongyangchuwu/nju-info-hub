import { describe, expect, it } from "vitest";
import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
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
  attachments: NoticeQueryResult["attachments"] = [],
): NoticeQueryResult {
  return {
    sourceId: source.id,
    sourceItemId: itemId,
    sourceName: source.name,
    organization: source.organization,
    revisionNumber: 1,
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
  const seminarNewest = notice(seminars, "seminar-new", "2026-09-23", "2026-09-24T03:00:00Z", [
    { url: "https://cs.nju.edu.cn/a.pdf", title: "A.pdf", mediaType: "application/pdf" },
  ]);
  const seminarTie = notice(seminars, "seminar-tie", "2026-09-22", "2026-09-24T04:00:00Z");
  const parts = [
    { source: graduate, notices: [graduateDated, graduateUndated] },
    { source: seminars, notices: [seminarNewest, seminarTie] },
  ];

  it("orders dates across sources while preserving per-source stable identity and original links", () => {
    const feed = buildJsonBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.json",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(feed.items.map((item) => item.id)).toEqual([
      "nju-cs-seminars:seminar-new",
      "nju-cs-graduate:grad-a",
      "nju-cs-seminars:seminar-tie",
      "nju-cs-graduate:grad-undated",
    ]);
    expect(feed.items[0]).toMatchObject({
      url: seminarNewest.url,
      attachments: [{ url: "https://cs.nju.edu.cn/a.pdf", mime_type: "application/pdf", title: "A.pdf" }],
      _nju: {
        source_id: seminars.id,
        source_name: seminars.name,
        organization: seminars.organization,
      },
    });
    expect(feed._nju.source_set).toEqual({
      id: "cs",
      title: "Computer Science public information",
      source_ids: [graduate.id, seminars.id],
    });
  });

  it("uses standard Atom and RSS per-entry source attribution", () => {
    const atom = buildAtomBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.atom",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(atom).toContain("<source>");
    expect(atom).toContain("<title>School of Computer Science — Seminars</title>");
    expect(atom).toContain('<link rel="alternate" href="https://cs.nju.edu.cn/1706/list.htm"/>');
    expect(atom).toContain('<link rel="enclosure" href="https://cs.nju.edu.cn/a.pdf" type="application/pdf" title="A.pdf"/>');

    const rss = buildRssBundle(set, parts, {
      selfUrl: "https://example.org/bundles/cs.rss",
      generatedAt: "2026-09-24T05:00:00Z",
    });
    expect(rss).toContain('<source url="https://cs.nju.edu.cn/1703/list.htm">School of Computer Science — Graduate notices</source>');
    expect(rss).toContain('<source url="https://cs.nju.edu.cn/1706/list.htm">School of Computer Science — Seminars</source>');
    expect(rss).not.toContain("<enclosure");
    expect(rss).toContain("https://cs.nju.edu.cn/a.pdf");
  });
});
