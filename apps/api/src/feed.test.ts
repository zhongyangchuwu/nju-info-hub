import { describe, expect, it } from "vitest";
import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { buildJsonFeed } from "./feed.js";

const source: PersistedSourceSummary = {
  id: "nju-cs-graduate",
  name: "Graduate notices",
  organization: { id: "nju-cs", name: "School of Computer Science" },
  url: "https://cs.nju.edu.cn/graduate/list.htm",
  enabled: true,
};

const notice: NoticeQueryResult = {
  sourceId: source.id,
  sourceItemId: "news/123:4",
  sourceName: source.name,
  organization: source.organization,
  revisionNumber: 2,
  url: "https://cs.nju.edu.cn/news/123/page.htm",
  title: "Updated notice",
  publishedAtRaw: "2026年9月23日",
  publishedOn: "2026-09-23",
  bodyText: "Plain text for readers",
  bodyHtml: "<p>Original <strong>HTML</strong></p>",
  attachments: [
    { url: "https://cs.nju.edu.cn/upload/first.pdf?download=1", title: "First PDF" },
    { url: "https://cs.nju.edu.cn/download?id=2", title: "Template.docx" },
    { url: "https://cs.nju.edu.cn/file.bin", title: "Unknown file" },
    { url: "https://cs.nju.edu.cn/report", title: "Report", mediaType: "application/vnd.custom" },
  ],
  provenance: { fetchedAt: "2026-09-23T11:00:00.000Z", contentSha256: "a".repeat(64) },
};

describe("JSON Feed builder", () => {
  it("preserves stable identity, source provenance, day precision, body and every attachment", () => {
    const feed = buildJsonFeed(source, [notice]);
    expect(feed).toMatchObject({
      version: "https://jsonfeed.org/version/1.1",
      title: "School of Computer Science — Graduate notices",
      home_page_url: source.url,
      _nju: { source_id: source.id, organization: source.organization },
    });
    expect(feed).not.toHaveProperty("feed_url");
    expect(feed.items[0]).toEqual({
      id: "nju-cs-graduate:news%2F123%3A4",
      url: notice.url,
      title: notice.title,
      content_html: notice.bodyHtml,
      content_text: notice.bodyText,
      attachments: [
        { url: notice.attachments[0]?.url, title: "First PDF", mime_type: "application/pdf" },
        { url: notice.attachments[1]?.url, title: "Template.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        { url: notice.attachments[2]?.url, title: "Unknown file", mime_type: "application/octet-stream" },
        { url: notice.attachments[3]?.url, title: "Report", mime_type: "application/vnd.custom" },
      ],
      _nju: {
        source_id: source.id, source_name: source.name, organization: source.organization,
        published_on: "2026-09-23", date_precision: "day", revision_number: 2,
        fetched_at: notice.provenance.fetchedAt, content_sha256: notice.provenance.contentSha256,
      },
    });
    expect(feed.items[0]).not.toHaveProperty("date_published");
    expect(buildJsonFeed(source, [{ ...notice, revisionNumber: 3, title: "Another revision" }]).items[0]?.id)
      .toBe(feed.items[0]?.id);
  });

  it("omits missing HTML and unknown dates while retaining required text", () => {
    const item = buildJsonFeed(source, [{ ...notice, publishedOn: null, bodyHtml: "", bodyText: "", attachments: [] }]).items[0];
    expect(item).toMatchObject({ content_text: "" });
    expect(item).not.toHaveProperty("content_html");
    expect(item?._nju).not.toHaveProperty("published_on");
    expect(item?._nju).not.toHaveProperty("date_precision");
    expect(item).not.toHaveProperty("date_published");
  });
});
