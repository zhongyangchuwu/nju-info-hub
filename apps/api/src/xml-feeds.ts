import type { NoticeQueryResult, PersistedSourceSummary } from "@nju-info/db";
import { syndicationFeed, xmlEscape, type SyndicationContext, type SyndicationEntry } from "./syndication.js";

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';

/** Atom 1.0: updated is the hub's observed current revision, not an upstream modification time. */
export function buildAtomFeed(source: PersistedSourceSummary, notices: NoticeQueryResult[], context: SyndicationContext = {}): string {
  const feed = syndicationFeed(source, notices, context.generatedAt);
  const lines = [
    xmlDeclaration,
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${xmlEscape(source.url)}</id>`,
    `  <title>${xmlEscape(feed.title)}</title>`,
    `  <link rel="alternate" href="${xmlEscape(source.url)}"/>`,
    ...(context.selfUrl ? [`  <link rel="self" type="application/atom+xml" href="${xmlEscape(context.selfUrl)}"/>`] : []),
    `  <updated>${xmlEscape(feed.updatedAt)}</updated>`,
    ...feed.entries.flatMap((entry) => [
      '  <entry>',
      `    <id>${xmlEscape(entry.id)}</id>`,
      `    <title>${xmlEscape(entry.title)}</title>`,
      `    <link rel="alternate" href="${xmlEscape(entry.url)}"/>`,
      `    <updated>${xmlEscape(entry.updatedAt)}</updated>`,
      ...(entry.publishedAt ? [`    <published>${xmlEscape(entry.publishedAt)}</published>`] : []),
      ...(entry.bodyHtml ? [
        `    <content type="html">${xmlEscape(entry.bodyHtml)}</content>`,
      ] : [`    <content type="text">${xmlEscape(entry.bodyText)}</content>`]),
      ...entry.attachments.map((attachment) =>
        `    <link rel="enclosure" href="${xmlEscape(attachment.url)}" type="${xmlEscape(attachment.mimeType)}" title="${xmlEscape(attachment.title)}"/>`),
      '  </entry>',
    ]),
    '</feed>',
  ];
  return `${lines.join("\n")}\n`;
}

function rssDescription(entry: SyndicationEntry): string {
  const content = entry.bodyHtml || xmlEscape(entry.bodyText).replace(/\n/g, "<br/>");
  if (!entry.attachments.length) return content;
  const links = entry.attachments.map((attachment) =>
    `<li><a href="${xmlEscape(attachment.url)}">${xmlEscape(attachment.title)}</a></li>`).join("");
  return `${content}<p>Attachments:</p><ul>${links}</ul>`;
}

/** RSS 2.0: link every attachment in description; enclosure requires unavailable byte length. */
export function buildRssFeed(source: PersistedSourceSummary, notices: NoticeQueryResult[], context: SyndicationContext = {}): string {
  const feed = syndicationFeed(source, notices, context.generatedAt);
  const lines = [
    xmlDeclaration,
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${xmlEscape(feed.title)}</title>`,
    `    <link>${xmlEscape(source.url)}</link>`,
    `    <description>${xmlEscape(feed.title)}</description>`,
    `    <lastBuildDate>${new Date(feed.updatedAt).toUTCString()}</lastBuildDate>`,
    ...feed.entries.flatMap((entry) => [
      '    <item>',
      `      <guid isPermaLink="false">${xmlEscape(entry.id)}</guid>`,
      `      <title>${xmlEscape(entry.title)}</title>`,
      `      <link>${xmlEscape(entry.url)}</link>`,
      ...(entry.publishedAt ? [`      <pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>`] : []),
      `      <description>${xmlEscape(rssDescription(entry))}</description>`,
      '    </item>',
    ]),
    '  </channel>',
    '</rss>',
  ];
  return `${lines.join("\n")}\n`;
}
