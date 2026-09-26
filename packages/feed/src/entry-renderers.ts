import { entryXmlMetadata, xmlEscape, type SyndicationEntry } from "./syndication.js";

export interface EntrySourceAttribution {
  url: string;
  title: string;
}

export function jsonFeedItem(entry: SyndicationEntry) {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
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
      content_status: entry.contentStatus,
      ...(entry.acquisitionKind == null ? {} : { acquisition_kind: entry.acquisitionKind }),
      ...(entry.observationRevisionNumber === undefined ? {} : {
        observation_revision_number: entry.observationRevisionNumber,
      }),
      ...(entry.revisionNumber === undefined ? {} : { revision_number: entry.revisionNumber }),
      fetched_at: entry.fetchedAt,
      content_sha256: entry.contentSha256,
    },
  };
}

export function atomEntryLines(
  entry: SyndicationEntry,
  source?: EntrySourceAttribution,
): string[] {
  return [
    "  <entry>",
    `    <id>${xmlEscape(entry.id)}</id>`,
    `    <title>${xmlEscape(entry.title)}</title>`,
    `    <link rel="alternate" href="${xmlEscape(entry.url)}"/>`,
    `    <updated>${xmlEscape(entry.updatedAt)}</updated>`,
    ...(entry.bodyHtml
      ? [`    <content type="html">${xmlEscape(entry.bodyHtml)}</content>`]
      : [`    <content type="text">${xmlEscape(entry.bodyText)}</content>`]),
    ...entryXmlMetadata(entry, "    "),
    ...(source ? [
      "    <source>",
      `      <id>${xmlEscape(source.url)}</id>`,
      `      <title>${xmlEscape(source.title)}</title>`,
      `      <link rel="alternate" href="${xmlEscape(source.url)}"/>`,
      "    </source>",
    ] : []),
    ...entry.attachments.map((attachment) =>
      `    <link rel="enclosure" href="${xmlEscape(attachment.url)}" type="${xmlEscape(attachment.mimeType)}" title="${xmlEscape(attachment.title)}"/>`),
    "  </entry>",
  ];
}

function rssDescription(entry: SyndicationEntry): string {
  const content = entry.bodyHtml || xmlEscape(entry.bodyText).replace(/\n/g, "<br/>");
  if (!entry.attachments.length) return content;
  const links = entry.attachments.map((attachment) =>
    `<li><a href="${xmlEscape(attachment.url)}">${xmlEscape(attachment.title)}</a></li>`).join("");
  return `${content}<p>Attachments:</p><ul>${links}</ul>`;
}

export function rssItemLines(
  entry: SyndicationEntry,
  source?: EntrySourceAttribution,
): string[] {
  return [
    "    <item>",
    `      <guid isPermaLink="false">${xmlEscape(entry.id)}</guid>`,
    `      <title>${xmlEscape(entry.title)}</title>`,
    `      <link>${xmlEscape(entry.url)}</link>`,
    ...(source ? [
      `      <source url="${xmlEscape(source.url)}">${xmlEscape(source.title)}</source>`,
    ] : []),
    `      <description>${xmlEscape(rssDescription(entry))}</description>`,
    ...entryXmlMetadata(entry, "      "),
    "    </item>",
  ];
}
