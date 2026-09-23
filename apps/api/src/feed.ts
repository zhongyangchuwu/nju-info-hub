import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { syndicationFeed, type SyndicationContext } from "./syndication.js";

/** Serialize current revisions in database order; day-only timestamps are transport encodings, not source times. */
export function buildJsonFeed(source: PersistedSourceSummary, notices: NoticeQueryResult[], context: SyndicationContext = {}) {
  const feed = syndicationFeed(source, notices, context.generatedAt);
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: feed.title,
    home_page_url: source.url,
    ...(context.selfUrl ? { feed_url: context.selfUrl } : {}),
    _nju: { source_id: source.id, organization: source.organization },
    items: feed.entries.map((entry) => ({
      id: entry.id,
      url: entry.url,
      title: entry.title,
      ...(entry.publishedAt ? { date_published: entry.publishedAt } : {}),
      ...(entry.bodyHtml ? { content_html: entry.bodyHtml } : {}),
      content_text: entry.bodyText,
      ...(entry.attachments.length ? {
        attachments: entry.attachments.map((attachment) => ({
          url: attachment.url,
          mime_type: attachment.mimeType,
          title: attachment.title,
        })),
      } : {}),
      _nju: {
        source_id: entry.sourceId,
        source_name: entry.sourceName,
        organization: entry.organization,
        ...(entry.publishedOn === null ? {} : {
          published_on: entry.publishedOn,
          date_precision: "day",
        }),
        revision_number: entry.revisionNumber,
        fetched_at: entry.fetchedAt,
        content_sha256: entry.contentSha256,
      },
    })),
  };
}
