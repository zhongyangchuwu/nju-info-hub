import { describe, expect, it } from "vitest";
import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { buildJsonFeed } from "./feed.js";

const source: PersistedSourceSummary = {
  id: "nju-cs-graduate",
  name: "Graduate notices",
  organization: { id: "nju-cs", name: "School of Computer Science" },
  url: "https://cs.nju.edu.cn/graduate/list.htm",
};

const notice: SourceEntryQueryResult = {
  sourceId: source.id,
  sourceItemId: "news/123:4",
  sourceName: source.name,
  organization: source.organization,
  noticeRevisionNumber: 2,
  observationRevisionNumber: 1,
  contentStatus: "full",
  acquisitionKind: "webplus-detail",
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
  it("preserves full-entry identity, source provenance, day precision, body and every attachment", () => {
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
      date_published: "2026-09-23T00:00:00+08:00",
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
        published_on: "2026-09-23", date_precision: "day", content_status: "full",
        acquisition_kind: "webplus-detail", observation_revision_number: 1, revision_number: 2,
        fetched_at: notice.provenance.fetchedAt, content_sha256: notice.provenance.contentSha256,
      },
    });
    expect(buildJsonFeed(source, [{ ...notice, provenance: { ...notice.provenance,
      fetchedAt: "2026-09-24T11:00:00.000Z" } }]).items[0]?.date_published)
      .toBe("2026-09-23T00:00:00+08:00");
    expect(buildJsonFeed(source, [{ ...notice, noticeRevisionNumber: 3, title: "Another revision" }]).items[0]?.id)
      .toBe(feed.items[0]?.id);
  });

  it("emits link-only status without fabricating body HTML or attachments", () => {
    const linkOnly: SourceEntryQueryResult = {
      ...notice,
      sourceItemId: "news/124:4",
      title: "Link-only notice",
      contentStatus: "link-only",
      acquisitionKind: null,
      observationRevisionNumber: 3,
      noticeRevisionNumber: null,
      bodyText: "",
      bodyHtml: "",
      attachments: [],
      provenance: { fetchedAt: "2026-09-24T11:00:00.000Z", contentSha256: "b".repeat(64) },
    };
    const item = buildJsonFeed(source, [notice, linkOnly]).items[1]!;
    expect(item).toMatchObject({
      id: "nju-cs-graduate:news%2F124%3A4",
      title: "Link-only notice",
      content_text: "Full text is unavailable from the public collector; open the original item.",
      _nju: {
        content_status: "link-only",
        observation_revision_number: 3,
        fetched_at: "2026-09-24T11:00:00.000Z",
        content_sha256: "b".repeat(64),
      },
    });
    expect(item).not.toHaveProperty("content_html");
    expect(item).not.toHaveProperty("attachments");
    expect(item._nju).not.toHaveProperty("revision_number");
    expect(item._nju).not.toHaveProperty("acquisition_kind");
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
