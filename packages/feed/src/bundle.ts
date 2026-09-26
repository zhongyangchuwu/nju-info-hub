import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";
import { atomEntryLines, jsonFeedItem, rssItemLines } from "./entry-renderers.js";
import { feedMetadataNamespace, feedTitle, syndicationFeed, xmlEscape, type SyndicationContext, type SyndicationEntry } from "./syndication.js";
import type { ResolvedSourceSet } from "./source-set.js";

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';

export interface BundlePart {
  source: PersistedSourceSummary;
  entries: SourceEntryQueryResult[];
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
  const entries = parts.flatMap(({ source, entries }) =>
    syndicationFeed(source, entries).entries.map((entry) => ({
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
    items: entries.map(jsonFeedItem),
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
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:nju="${feedMetadataNamespace}">`,
    "  <id>" + xmlEscape(feedId) + "</id>",
    "  <title>" + xmlEscape(set.title) + "</title>",
    ...(context.selfUrl ? ['  <link rel="self" type="application/atom+xml" href="' + xmlEscape(context.selfUrl) + '"/>'] : []),
    "  <updated>" + xmlEscape(updatedAt) + "</updated>",
    ...entries.flatMap((entry) => atomEntryLines(entry, {
      url: entry.sourceUrl,
      title: entry.sourceTitle,
    })),
    "</feed>",
  ];
  return lines.join("\n") + "\n";
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
    `<rss version="2.0" xmlns:nju="${feedMetadataNamespace}">`,
    "  <channel>",
    "    <title>" + xmlEscape(set.title) + "</title>",
    "    <link>" + xmlEscape(channelLink) + "</link>",
    "    <description>" + xmlEscape(set.title) + "</description>",
    "    <lastBuildDate>" + new Date(updatedAt).toUTCString() + "</lastBuildDate>",
    ...entries.flatMap((entry) => rssItemLines(entry, {
      url: entry.sourceUrl,
      title: entry.sourceTitle,
    })),
    "  </channel>",
    "</rss>",
  ];
  return lines.join("\n") + "\n";
}
