import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { jsonFeedItem } from "./entry-renderers.js";
import { syndicationFeed, type SyndicationContext } from "./syndication.js";

/** Serialize source observations in database order without inventing timestamp precision. */
export function buildJsonFeed(source: PersistedSourceSummary, sourceEntries: SourceEntryQueryResult[], context: SyndicationContext = {}) {
  const feed = syndicationFeed(source, sourceEntries, context.generatedAt);
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: feed.title,
    home_page_url: source.url,
    ...(context.selfUrl ? { feed_url: context.selfUrl } : {}),
    _nju: { source_id: source.id, organization: source.organization },
    items: feed.entries.map(jsonFeedItem),
  };
}
