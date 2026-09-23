import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";

const mimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  zip: "application/zip",
};

function mimeType(url: string, title: string, stored: string | undefined): string {
  if (stored) return stored;
  const urlExtension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  const titleExtension = /\.([a-z0-9]+)$/i.exec(title.trim())?.[1]?.toLowerCase();
  return (urlExtension && mimeTypes[urlExtension]) ||
    (titleExtension && mimeTypes[titleExtension]) || "application/octet-stream";
}

/** Serialize the current persisted revisions, in database order, without inferring publication times. */
export function buildJsonFeed(source: PersistedSourceSummary, notices: NoticeQueryResult[]) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: `${source.organization.name} — ${source.name}`,
    home_page_url: source.url,
    _nju: { source_id: source.id, organization: source.organization },
    items: notices.map((notice) => ({
      id: `${encodeURIComponent(notice.sourceId)}:${encodeURIComponent(notice.sourceItemId)}`,
      url: notice.url,
      title: notice.title,
      ...(notice.bodyHtml ? { content_html: notice.bodyHtml } : {}),
      content_text: notice.bodyText,
      ...(notice.attachments.length ? {
        attachments: notice.attachments.map((attachment) => ({
          url: attachment.url,
          mime_type: mimeType(attachment.url, attachment.title, attachment.mediaType),
          title: attachment.title,
        })),
      } : {}),
      _nju: {
        source_id: notice.sourceId,
        source_name: notice.sourceName,
        organization: notice.organization,
        ...(notice.publishedOn === null ? {} : {
          published_on: notice.publishedOn,
          date_precision: "day",
        }),
        revision_number: notice.revisionNumber,
        fetched_at: notice.provenance.fetchedAt,
        content_sha256: notice.provenance.contentSha256,
      },
    })),
  };
}
