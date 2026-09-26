import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";

const linkOnlyContentText = "Full text is unavailable from the public collector; open the original item.";
/** XML extension is emitted only when a feed contains link-only entries. */
export const feedMetadataNamespace = "https://zhongyangchuwu.github.io/nju-info-hub/ns/feed";

export function linkOnlyXmlMetadata(entry: SyndicationEntry, indent: string): string[] {
  if (entry.contentStatus !== "link-only") return [];
  return [
    `${indent}<nju:content_status>link-only</nju:content_status>`,
    ...(entry.acquisitionKind ? [`${indent}<nju:acquisition_kind>${xmlEscape(entry.acquisitionKind)}</nju:acquisition_kind>`] : []),
    `${indent}<nju:fetched_at>${xmlEscape(entry.fetchedAt)}</nju:fetched_at>`,
    `${indent}<nju:content_sha256>${xmlEscape(entry.contentSha256)}</nju:content_sha256>`,
  ];
}
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

export type FeedFormat = "json" | "atom" | "rss";

export interface SyndicationContext {
  selfUrl?: string;
  /** Explicit generation time for an empty Atom feed (no revision history exists). */
  generatedAt?: string;
}

export function feedTitle(source: PersistedSourceSummary): string {
  return `${source.organization.name} — ${source.name}`;
}

export interface SyndicationEntry {
  id: string;
  url: string;
  title: string;
  publishedOn: string | null;
  publishedAt?: string;
  updatedAt: string;
  contentStatus: SourceEntryQueryResult["contentStatus"];
  acquisitionKind?: NonNullable<SourceEntryQueryResult["acquisitionKind"]>;
  observationRevisionNumber?: number;
  bodyHtml: string;
  bodyText: string;
  attachments: { url: string; title: string; mimeType: string }[];
  sourceId: string;
  sourceName: string;
  organization: SourceEntryQueryResult["organization"];
  revisionNumber?: number;
  contentSha256: string;
  fetchedAt: string;
}

export interface SyndicationFeed {
  source: PersistedSourceSummary;
  title: string;
  entries: SyndicationEntry[];
  /** Latest source observation; empty feeds use the supplied generation time. */
  updatedAt: string;
}

function rfc3339(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error(`invalid feed timestamp: ${value}`);
  return time.toISOString();
}
/** Project persisted source observations once, preserving database order and day precision. */
export function syndicationFeed(source: PersistedSourceSummary, sourceEntries: SourceEntryQueryResult[], generatedAt?: string): SyndicationFeed {
  const entries = sourceEntries.map((sourceEntry): SyndicationEntry => {
    const linkOnly = sourceEntry.contentStatus === "link-only";
    return {
      id: `${encodeURIComponent(sourceEntry.sourceId)}:${encodeURIComponent(sourceEntry.sourceItemId)}`,
      url: sourceEntry.url,
      title: sourceEntry.title,
      publishedOn: sourceEntry.publishedOn,
      ...(sourceEntry.publishedOn === null ? {} : { publishedAt: `${sourceEntry.publishedOn}T00:00:00+08:00` }),
      updatedAt: rfc3339(sourceEntry.provenance.fetchedAt),
      fetchedAt: sourceEntry.provenance.fetchedAt,
      contentStatus: sourceEntry.contentStatus,
      ...(sourceEntry.acquisitionKind === null ? {} : { acquisitionKind: sourceEntry.acquisitionKind }),
      ...(sourceEntry.observationRevisionNumber === null ? {} : {
        observationRevisionNumber: sourceEntry.observationRevisionNumber,
      }),
      ...(sourceEntry.contentStatus === "full" && sourceEntry.noticeRevisionNumber !== null ? {
        revisionNumber: sourceEntry.noticeRevisionNumber,
      } : {}),
      bodyHtml: linkOnly ? "" : sourceEntry.bodyHtml,
      bodyText: linkOnly ? linkOnlyContentText : sourceEntry.bodyText,
      attachments: linkOnly ? [] : sourceEntry.attachments.map((attachment) => ({
        url: attachment.url,
        title: attachment.title,
        mimeType: mimeType(attachment.url, attachment.title, attachment.mediaType),
      })),
      sourceId: sourceEntry.sourceId,
      sourceName: sourceEntry.sourceName,
      organization: sourceEntry.organization,
      contentSha256: sourceEntry.provenance.contentSha256,
    };
  });
  const updatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, "");
  return { source, title: feedTitle(source), entries, updatedAt: updatedAt || rfc3339(generatedAt || new Date().toISOString()) };
}

/** XML 1.0 text/attribute escaping; exclude characters XML cannot represent. */
export function xmlEscape(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]|[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return "";
    }
  });
}

export function feedSelfUrl(base: URL, sourceId: string, format: FeedFormat): string {
  return new URL(`feeds/${encodeURIComponent(sourceId)}.${format}`, base).href;
}

export function publicBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("public base URL must be an absolute http/https URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("public base URL must be an absolute http/https URL without credentials, query or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}
