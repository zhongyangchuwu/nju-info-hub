import type { PersistedSourceSummary } from "@nju-info/db";
import { feedSelfUrl, feedTitle, xmlEscape } from "./syndication.js";

/** A selected-source subscription catalog, not a personalized or combined feed. */
export function buildOpml(sources: readonly PersistedSourceSummary[], base: URL): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>NJU Info Hub subscriptions</title></head>',
    '  <body>',
    ...sources.map((source) => {
      const title = xmlEscape(feedTitle(source));
      return `    <outline text="${title}" title="${title}" type="rss" xmlUrl="${xmlEscape(feedSelfUrl(base, source.id, "rss"))}" htmlUrl="${xmlEscape(source.url)}"/>`;
    }),
    '  </body>',
    '</opml>',
    '',
  ].join("\n");
}
