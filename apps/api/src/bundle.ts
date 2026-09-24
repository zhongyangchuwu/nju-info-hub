import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { feedTitle, syndicationFeed, xmlEscape, type SyndicationContext, type SyndicationEntry } from "./syndication.js";
import type { ResolvedSourceSet } from "./source-set.js";

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';

export interface BundlePart {
  source: PersistedSourceSummary;
  notices: NoticeQueryResult[];
}

interface BundleEntry extends SyndicationEntry {
  sourceUrl: string;
  sourceTitle: string;
}

function orderEntries(entries: BundleEntry[]): BundleEntry[] {
  return entries.sort((left, right) => {
    if (left.publishedOn !== null && right.publishedOn !== null) {
      const byDate = right.publishedOn.localeCompare(left.publishedOn);
      if (byDate !== 0) return byDate;
    } else if (left.publishedOn !== null) {
      return -1;
    } else if (right.publishedOn !== null) {
      return 1;
    }
    const bySource = left.sourceId.localeCompare(right.sourceId);
    if (bySource !== 0) return bySource;
    return left.id.localeCompare(right.id);
  });
}

function bundleEntries(parts: readonly BundlePart[]): BundleEntry[] {
  const entries = parts.flatMap(({ source, notices }) =>
    syndicationFeed(source, notices).entries.map((entry) => ({
      ...entry,
      sourceUrl: source.url,
      sourceTitle: feedTitle(source),
    })));
  return orderEntries(entries);
}

function bundleUpdatedAt(entries: readonly BundleEntry[], generatedAt?: string): string {
  const latest = entries.reduce((value, entry) => entry.updatedAt > value ? entry.updatedAt : value, "");
  if (latest) return latest;
  const time = new Date(generatedAt ?? new Date().toISOString());
  if (!Number.isFinite(time.getTime())) throw new Error("invalid feed timestamp: " + generatedAt);
  return time.toISOString();
}

function jsonItem(entry: BundleEntry) {
  return {
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
  };
}

export function buildJsonBundle(
  set: ResolvedSourceSet,
  parts: readonly BundlePart[],
  context: SyndicationContext = {},
) {
  const entries = bundleEntries(parts);
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: set.title,
    ...(context.selfUrl ? { feed_url: context.selfUrl } : {}),
    _nju: {
      source_set: {
        id: set.id,
        title: set.title,
        source_ids: set.sourceIds,
      },
    },
    items: entries.map(jsonItem),
  };
}

export function buildAtomBundle(
  set: ResolvedSourceSet,
  parts: readonly BundlePart[],
  context: SyndicationContext = {},
): string {
  const entries = bundleEntries(parts);
  const updatedAt = bundleUpdatedAt(entries, context.generatedAt);
  const feedId = context.selfUrl ?? "urn:nju-info-hub:bundle:" + set.id;
  const lines = [
    xmlDeclaration,
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <id>" + xmlEscape(feedId) + "</id>",
    "  <title>" + xmlEscape(set.title) + "</title>",
    ...(context.selfUrl ? ['  <link rel="self" type="application/atom+xml" href="' + xmlEscape(context.selfUrl) + '"/>'] : []),
    "  <updated>" + xmlEscape(updatedAt) + "</updated>",
    ...entries.flatMap((entry) => [
      "  <entry>",
      "    <id>" + xmlEscape(entry.id) + "</id>",
      "    <title>" + xmlEscape(entry.title) + "</title>",
      '    <link rel="alternate" href="' + xmlEscape(entry.url) + '"/>',
      "    <updated>" + xmlEscape(entry.updatedAt) + "</updated>",
      ...(entry.publishedAt ? ["    <published>" + xmlEscape(entry.publishedAt) + "</published>"] : []),
      ...(entry.bodyHtml
        ? ['    <content type="html">' + xmlEscape(entry.bodyHtml) + "</content>"]
        : ['    <content type="text">' + xmlEscape(entry.bodyText) + "</content>"]),
      "    <source>",
      "      <id>" + xmlEscape(entry.sourceUrl) + "</id>",
      "      <title>" + xmlEscape(entry.sourceTitle) + "</title>",
      '      <link rel="alternate" href="' + xmlEscape(entry.sourceUrl) + '"/>',
      "    </source>",
      ...entry.attachments.map((attachment) =>
        '    <link rel="enclosure" href="' + xmlEscape(attachment.url) + '" type="' +
        xmlEscape(attachment.mimeType) + '" title="' + xmlEscape(attachment.title) + '"/>'),
      "  </entry>",
    ]),
    "</feed>",
  ];
  return lines.join("\n") + "\n";
}

function rssDescription(entry: BundleEntry): string {
  const content = entry.bodyHtml || xmlEscape(entry.bodyText).replace(/\n/g, "<br/>");
  if (!entry.attachments.length) return content;
  const links = entry.attachments.map((attachment) =>
    '<li><a href="' + xmlEscape(attachment.url) + '">' + xmlEscape(attachment.title) + "</a></li>").join("");
  return content + "<p>Attachments:</p><ul>" + links + "</ul>";
}

export function buildRssBundle(
  set: ResolvedSourceSet,
  parts: readonly BundlePart[],
  context: SyndicationContext = {},
): string {
  const entries = bundleEntries(parts);
  const updatedAt = bundleUpdatedAt(entries, context.generatedAt);
  const channelLink = context.selfUrl ?? "urn:nju-info-hub:bundle:" + set.id;
  const lines = [
    xmlDeclaration,
    '<rss version="2.0">',
    "  <channel>",
    "    <title>" + xmlEscape(set.title) + "</title>",
    "    <link>" + xmlEscape(channelLink) + "</link>",
    "    <description>" + xmlEscape(set.title) + "</description>",
    "    <lastBuildDate>" + new Date(updatedAt).toUTCString() + "</lastBuildDate>",
    ...entries.flatMap((entry) => [
      "    <item>",
      '      <guid isPermaLink="false">' + xmlEscape(entry.id) + "</guid>",
      "      <title>" + xmlEscape(entry.title) + "</title>",
      "      <link>" + xmlEscape(entry.url) + "</link>",
      ...(entry.publishedAt ? ["      <pubDate>" + new Date(entry.publishedAt).toUTCString() + "</pubDate>"] : []),
      '      <source url="' + xmlEscape(entry.sourceUrl) + '">' + xmlEscape(entry.sourceTitle) + "</source>",
      "      <description>" + xmlEscape(rssDescription(entry)) + "</description>",
      "    </item>",
    ]),
    "  </channel>",
    "</rss>",
  ];
  return lines.join("\n") + "\n";
}
