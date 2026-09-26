import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { atomEntryLines, rssItemLines } from "./entry-renderers.js";
import { feedMetadataNamespace, syndicationFeed, xmlEscape, type SyndicationContext } from "./syndication.js";

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';

/** Atom 1.0: updated is the hub's latest observed source-item time, not an upstream modification time. */
export function buildAtomFeed(source: PersistedSourceSummary, sourceEntries: SourceEntryQueryResult[], context: SyndicationContext = {}): string {
  const feed = syndicationFeed(source, sourceEntries, context.generatedAt);
  const lines = [
    xmlDeclaration,
    `<feed xmlns="http://www.w3.org/2005/Atom"${feed.entries.some((entry) => entry.contentStatus === "link-only") ? ` xmlns:nju="${feedMetadataNamespace}"` : ""}>`,
    `  <id>${xmlEscape(source.url)}</id>`,
    `  <title>${xmlEscape(feed.title)}</title>`,
    `  <link rel="alternate" href="${xmlEscape(source.url)}"/>`,
    ...(context.selfUrl ? [`  <link rel="self" type="application/atom+xml" href="${xmlEscape(context.selfUrl)}"/>`] : []),
    `  <updated>${xmlEscape(feed.updatedAt)}</updated>`,
    ...feed.entries.flatMap((entry) => atomEntryLines(entry)),
    '</feed>',
  ];
  return `${lines.join("\n")}\n`;
}

/** RSS 2.0: link every attachment in description; enclosure requires unavailable byte length. */
export function buildRssFeed(source: PersistedSourceSummary, sourceEntries: SourceEntryQueryResult[], context: SyndicationContext = {}): string {
  const feed = syndicationFeed(source, sourceEntries, context.generatedAt);
  const lines = [
    xmlDeclaration,
    `<rss version="2.0"${feed.entries.some((entry) => entry.contentStatus === "link-only") ? ` xmlns:nju="${feedMetadataNamespace}"` : ""}>`,
    '  <channel>',
    `    <title>${xmlEscape(feed.title)}</title>`,
    `    <link>${xmlEscape(source.url)}</link>`,
    `    <description>${xmlEscape(feed.title)}</description>`,
    `    <lastBuildDate>${new Date(feed.updatedAt).toUTCString()}</lastBuildDate>`,
    ...feed.entries.flatMap((entry) => rssItemLines(entry)),
    '  </channel>',
    '</rss>',
  ];
  return `${lines.join("\n")}\n`;
}
