import { describe, expect, it } from "vitest";
import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

const source: PersistedSourceSummary = {
  id: "nju-cs-graduate", name: '通告 & <课程> "甲"',
  organization: { id: "nju-cs", name: '计算机 & <学院> "乙"' },
  url: "https://cs.nju.edu.cn/list.htm?x=1&y=2",
};
const notice: SourceEntryQueryResult = {
  sourceId: source.id, sourceItemId: "news/123:4", sourceName: source.name,
  organization: source.organization, noticeRevisionNumber: 2, observationRevisionNumber: 1,
  contentStatus: "full", acquisitionKind: "webplus-detail",
  url: "https://cs.nju.edu.cn/page.htm?x=1&y=2",
  title: '通知 & <重要> "引号"', publishedAtRaw: "2026年9月23日", publishedOn: "2026-09-23",
  bodyText: '正文 & <tag> "引用"', bodyHtml: '<p>中文 &amp; &lt;tag&gt; "引号"</p>',
  attachments: [
    { url: "https://cs.nju.edu.cn/a.pdf?x=1&y=2", title: '文件 & <甲> "一".pdf' },
    { url: "https://cs.nju.edu.cn/b.docx", title: "资料.docx" },
  ],
  provenance: { fetchedAt: "2026-09-24T11:30:00.000Z", contentSha256: "a".repeat(64) },
};

function parseXmlDocument(xml: string): XmlElement[] {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  const decodedEntities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  };
  const tokens = xml.match(/<\?[^?]*\?>|<\/?[^>]+>|[^<]+/g) ?? [];
  if (tokens.join("") !== xml) throw new Error("malformed XML token");
  for (const token of tokens) {
    if (token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token)?.[1];
      const closed = stack.pop();
      if (!name || closed?.name !== name) throw new Error("mismatched XML element");
      continue;
    }
    if (token.startsWith("<")) {
      const name = /^<([A-Za-z_][\w.:-]*)(?:\s+[^<>]*?)?\s*(\/?)>$/.exec(token);
      if (!name || /&(?!amp;|lt;|gt;|quot;|apos;|#(?:\d+|x[\da-f]+);)/i.test(token)) {
        throw new Error("malformed XML start tag");
      }
      const element: XmlElement = { name: name[1]!, text: "", children: [] };
      (stack.at(-1)?.children ?? roots).push(element);
      if (name[2] !== "/") stack.push(element);
      continue;
    }
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#(?:\d+|x[\da-f]+);)/i.test(token)) {
      throw new Error("malformed XML entity");
    }
    if (stack.length) {
      stack.at(-1)!.text += token.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,
        (entity) => decodedEntities[entity] ?? entity);
    } else if (token.trim()) {
      throw new Error("text outside XML root");
    }
  }
  if (stack.length || roots.length !== 1) throw new Error("unclosed or multiple XML roots");
  return roots;
}

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

const linkOnly: SourceEntryQueryResult = {
  ...notice,
  sourceItemId: "news/124:4",
  title: "Link-only notice",
  contentStatus: "link-only",
  acquisitionKind: "public-wechat",
  noticeRevisionNumber: null,
  observationRevisionNumber: 3,
  bodyText: "",
  bodyHtml: "",
  attachments: [],
  provenance: { fetchedAt: "2026-09-25T01:00:00.000Z", contentSha256: "b".repeat(64) },
};

describe("standard XML feeds", () => {
  it("publishes Atom observation time, day transport, stable identity and all enclosures", () => {
    const atom = buildAtomFeed(source, [notice], { selfUrl: "https://example.org/feeds/nju-cs-graduate.atom" });
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(atom).toContain('<id>nju-cs-graduate:news%2F123%3A4</id>');
    expect(atom).toContain('<title>计算机 &amp; &lt;学院&gt; &quot;乙&quot; — 通告 &amp; &lt;课程&gt; &quot;甲&quot;</title>');
    expect(atom).toContain('<link rel="alternate" href="https://cs.nju.edu.cn/page.htm?x=1&amp;y=2"/>');
    expect(atom).toContain('<link rel="self" type="application/atom+xml" href="https://example.org/feeds/nju-cs-graduate.atom"/>');
    expect(atom).toContain('<published>2026-09-23T00:00:00+08:00</published>');
    expect(atom.match(/<updated>2026-09-24T11:30:00.000Z<\/updated>/g)).toHaveLength(2);
    expect(atom).toContain('<content type="html">&lt;p&gt;中文 &amp;amp; &amp;lt;tag&amp;gt; &quot;引号&quot;&lt;/p&gt;</content>');
    expect(atom).toContain('href="https://cs.nju.edu.cn/a.pdf?x=1&amp;y=2" type="application/pdf" title="文件 &amp; &lt;甲&gt; &quot;一&quot;.pdf"');
    expect(atom).toContain('href="https://cs.nju.edu.cn/b.docx" type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"');
    const revised = buildAtomFeed(source, [{ ...notice, noticeRevisionNumber: 3, title: "new" }]);
    expect(revised).toContain('<id>nju-cs-graduate:news%2F123%3A4</id>');
  });

  it("uses max observation time and explicit generation time only for empty Atom feeds", () => {
    const older = { ...notice, sourceItemId: "older", provenance: { ...notice.provenance, fetchedAt: "2026-09-22T10:00:00.000Z" } };
    const atom = buildAtomFeed(source, [notice, older]);
    expect(atom).toContain('  <updated>2026-09-24T11:30:00.000Z</updated>');
    const empty = buildAtomFeed(source, [], { generatedAt: "2026-09-25T00:00:00.000Z" });
    expect(empty).toContain('<updated>2026-09-25T00:00:00.000Z</updated>');
    expect(empty).not.toContain('<entry>');
    const undated = buildAtomFeed(source, [{ ...notice, publishedOn: null, bodyHtml: "" }]);
    expect(undated).not.toContain('<published>');
    expect(undated).toContain('<content type="text">正文 &amp; &lt;tag&gt; &quot;引用&quot;</content>');
  });

  it("publishes RSS original links, stable nonpermalink GUID, day transport, and every attachment without enclosures", () => {
    const rss = buildRssFeed(source, [notice]);
    expect(rss).toContain('<rss version="2.0">');
    expect(rss).toContain('<guid isPermaLink="false">nju-cs-graduate:news%2F123%3A4</guid>');
    expect(rss).toContain('<link>https://cs.nju.edu.cn/page.htm?x=1&amp;y=2</link>');
    expect(rss).toContain('<pubDate>Tue, 22 Sep 2026 16:00:00 GMT</pubDate>');
    expect(rss).toContain('<lastBuildDate>Thu, 24 Sep 2026 11:30:00 GMT</lastBuildDate>');
    expect(rss).toContain('&lt;p&gt;Attachments:&lt;/p&gt;&lt;ul&gt;');
    expect(rss).toContain('href=&quot;https://cs.nju.edu.cn/a.pdf?x=1&amp;amp;y=2&quot;');
    expect(rss).toContain('href=&quot;https://cs.nju.edu.cn/b.docx&quot;');
    expect(rss).toContain('文件 &amp;amp; &amp;lt;甲&amp;gt; &amp;quot;一&amp;quot;.pdf');
    expect(rss).not.toContain('<enclosure');
    expect(buildRssFeed(source, [{ ...notice, publishedOn: null }])).not.toContain('<pubDate>');
    expect(buildRssFeed(source, [], { generatedAt: "2026-09-25T00:00:00.000Z" }))
      .toContain('<lastBuildDate>Fri, 25 Sep 2026 00:00:00 GMT</lastBuildDate>');
  });

  it("emits link-only notes in mixed feeds without HTML or attachments and parses as XML", () => {
    const atomXml = buildAtomFeed(source, [notice, linkOnly]);
    const atom = parseXmlDocument(atomXml)[0]!;
    expect(atom.name).toBe("feed");
    const atomEntry = atom.children.find((entry) => entry.name === "entry" &&
      entry.children.some((child) => child.name === "id" && child.text === "nju-cs-graduate:news%2F124%3A4"))!;
    expect(atomEntry.children.find((child) => child.name === "content")?.text)
      .toBe("Full text is unavailable from the public collector; open the original item.");
    expect(atomEntry.children.filter((child) => child.name.startsWith("nju:"))
      .map((child) => [child.name, child.text])).toEqual([
      ["nju:content_status", "link-only"],
      ["nju:acquisition_kind", "public-wechat"],
      ["nju:fetched_at", linkOnly.provenance.fetchedAt],
      ["nju:content_sha256", linkOnly.provenance.contentSha256],
    ]);
    const atomEntryXml = atomXml.slice(atomXml.lastIndexOf("<entry>", atomXml.indexOf("news%2F124%3A4")),
      atomXml.indexOf("</entry>", atomXml.indexOf("news%2F124%3A4")) + "</entry>".length);
    expect(atomEntryXml).toContain('<content type="text">Full text is unavailable from the public collector; open the original item.</content>');
    expect(atomEntryXml).not.toContain('type="html"');
    expect(atomEntryXml).not.toContain('rel="enclosure"');

    const rssXml = buildRssFeed(source, [notice, linkOnly]);
    const rss = parseXmlDocument(rssXml)[0]!;
    expect(rss.name).toBe("rss");
    const item = rss.children[0]!.children.find((entry) => entry.name === "item" &&
      entry.children.some((child) => child.name === "guid" && child.text === "nju-cs-graduate:news%2F124%3A4"))!;
    expect(item.children.find((child) => child.name === "description")?.text)
      .toBe("Full text is unavailable from the public collector; open the original item.");
    expect(item.children.filter((child) => child.name.startsWith("nju:"))
      .map((child) => [child.name, child.text])).toEqual([
      ["nju:content_status", "link-only"],
      ["nju:acquisition_kind", "public-wechat"],
      ["nju:fetched_at", linkOnly.provenance.fetchedAt],
      ["nju:content_sha256", linkOnly.provenance.contentSha256],
    ]);
    const rssItemXml = rssXml.slice(rssXml.lastIndexOf("<item>", rssXml.indexOf("news%2F124%3A4")),
      rssXml.indexOf("</item>", rssXml.indexOf("news%2F124%3A4")) + "</item>".length);
    expect(rssItemXml).not.toContain("Attachments:");
    expect(rssItemXml).not.toContain("<enclosure");
  });
});
