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
  bodyHtml: string;
  bodyText: string;
  attachments: { url: string; title: string; mimeType: string }[];
  sourceId: string;
  sourceName: string;
  organization: NoticeQueryResult["organization"];
  revisionNumber: number;
  contentSha256: string;
  fetchedAt: string;
}

export interface SyndicationFeed {
  source: PersistedSourceSummary;
  title: string;
  entries: SyndicationEntry[];
  /** Latest observed current revision; empty feeds use the supplied generation time. */
  updatedAt: string;
}

function rfc3339(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error(`invalid feed timestamp: ${value}`);
  return time.toISOString();
}
/** Project persisted current revisions once, preserving database order and day precision. */
export function syndicationFeed(source: PersistedSourceSummary, notices: NoticeQueryResult[], generatedAt?: string): SyndicationFeed {
  const entries = notices.map((notice): SyndicationEntry => ({
    id: `${encodeURIComponent(notice.sourceId)}:${encodeURIComponent(notice.sourceItemId)}`,
    url: notice.url,
    title: notice.title,
    publishedOn: notice.publishedOn,
    ...(notice.publishedOn === null ? {} : { publishedAt: `${notice.publishedOn}T00:00:00+08:00` }),
    updatedAt: rfc3339(notice.provenance.fetchedAt),
    fetchedAt: notice.provenance.fetchedAt,
    bodyHtml: notice.bodyHtml,
    bodyText: notice.bodyText,
    attachments: notice.attachments.map((attachment) => ({
      url: attachment.url,
      title: attachment.title,
      mimeType: mimeType(attachment.url, attachment.title, attachment.mediaType),
    })),
    sourceId: notice.sourceId,
    sourceName: notice.sourceName,
    organization: notice.organization,
    revisionNumber: notice.revisionNumber,
    contentSha256: notice.provenance.contentSha256,
  }));
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
