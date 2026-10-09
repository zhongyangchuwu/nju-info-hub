import type { SocialEntryMetadata } from "@nju-info/core";
import type { PersistedSourceSummary, SourceEntryQueryResult } from "@nju-info/db";

const linkOnlyContentText = "Full text is unavailable from the public collector; open the original item.";
/** Namespace for metadata that standard feed formats cannot represent without fabricating precision. */
export const feedMetadataNamespace = "https://zhongyangchuwu.github.io/nju-info-hub/ns/feed";

export function entryXmlMetadata(entry: SyndicationEntry, indent: string): string[] {
  return [
    ...(entry.publishedOn === null ? [] : [
      `${indent}<nju:published_on>${xmlEscape(entry.publishedOn)}</nju:published_on>`,
      `${indent}<nju:date_precision>${xmlEscape(entry.social?.publicationTime.precision ?? "day")}</nju:date_precision>`,
    ]),
    ...(entry.contentStatus !== "link-only" ? [] : [
      `${indent}<nju:content_status>link-only</nju:content_status>`,
      ...(entry.acquisitionKind ? [
        `${indent}<nju:acquisition_kind>${xmlEscape(entry.acquisitionKind)}</nju:acquisition_kind>`,
      ] : []),
      `${indent}<nju:fetched_at>${xmlEscape(entry.fetchedAt)}</nju:fetched_at>`,
      `${indent}<nju:content_sha256>${xmlEscape(entry.contentSha256)}</nju:content_sha256>`,
    ]),
    ...(entry.social ? [
      `${indent}<nju:modified_at>${xmlEscape(entry.updatedAt)}</nju:modified_at>`,
      ...socialXmlMetadata(entry.social, indent),
    ] : []),
  ];
}

function socialXmlMetadata(social: SocialEntryMetadata, indent: string): string[] {
  const time = social.publicationTime;
  const origin = social.attribution.origin;
  return [
    `${indent}<nju:social>`,
    `${indent}  <nju:platform>${xmlEscape(social.platform)}</nju:platform>`,
    `${indent}  <nju:role>${xmlEscape(social.role)}</nju:role>`,
    `${indent}  <nju:publisher_identity scheme="${xmlEscape(social.publisherIdentity.scheme)}" version="${social.publisherIdentity.version}">${xmlEscape(social.publisherIdentity.value)}</nju:publisher_identity>`,
    `${indent}  <nju:native_identity scheme="${xmlEscape(social.nativeIdentity.scheme)}" version="${social.nativeIdentity.version}">`,
    ...(social.nativeIdentity.scheme === "wechat-mid-idx" ? [
      `${indent}    <nju:mid>${xmlEscape(social.nativeIdentity.mid)}</nju:mid>`,
      `${indent}    <nju:idx>${social.nativeIdentity.idx}</nju:idx>`,
    ] : [`${indent}    <nju:tid>${xmlEscape(social.nativeIdentity.tid)}</nju:tid>`]),
    `${indent}  </nju:native_identity>`,
    `${indent}  <nju:publication_time>`,
    ...(time.original ? [`${indent}    <nju:original representation="${xmlEscape(time.original.representation)}">${xmlEscape(time.original.value)}</nju:original>`] : []),
    `${indent}    <nju:precision>${xmlEscape(time.precision)}</nju:precision>`,
    ...(time.timezone === null ? [] : [`${indent}    <nju:timezone>${xmlEscape(time.timezone)}</nju:timezone>`]),
    ...(time.normalizedAt === null ? [] : [`${indent}    <nju:normalized_at>${xmlEscape(time.normalizedAt)}</nju:normalized_at>`]),
    ...(time.publishedOn === null ? [] : [`${indent}    <nju:published_on>${xmlEscape(time.publishedOn)}</nju:published_on>`]),
    `${indent}  </nju:publication_time>`,
    `${indent}  <nju:attribution relationship="${xmlEscape(social.attribution.relationship)}" verification="${xmlEscape(social.attribution.verification)}">`,
    ...(origin ? [
      `${indent}    <nju:origin>`,
      `${indent}      <nju:publisher_name>${xmlEscape(origin.publisherName)}</nju:publisher_name>`,
      ...(origin.publisherId === null ? [] : [`${indent}      <nju:publisher_id>${xmlEscape(origin.publisherId)}</nju:publisher_id>`]),
      ...(origin.nativeItemId === null ? [] : [`${indent}      <nju:native_item_id>${xmlEscape(origin.nativeItemId)}</nju:native_item_id>`]),
      ...(origin.url === null ? [] : [`${indent}      <nju:url>${xmlEscape(origin.url)}</nju:url>`]),
      `${indent}    </nju:origin>`,
    ] : []),
    `${indent}  </nju:attribution>`,
    `${indent}  <nju:policy_version>${xmlEscape(social.policyVersion)}</nju:policy_version>`,
    `${indent}  <nju:revision_number>${social.revisionNumber}</nju:revision_number>`,
    `${indent}</nju:social>`,
  ];
}

export function sourceXmlMetadata(source: PersistedSourceSummary, indent: string): string[] {
  return source.socialPublication ? [
    `${indent}<nju:social_publication status="${xmlEscape(source.socialPublication.status)}" changed_at="${xmlEscape(source.socialPublication.changedAt)}"/>`,
  ] : [];
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
  /** Day-only values use compatibility UTC noon; exact native social times remain exact. */
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
  social?: SocialEntryMetadata;
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

export function dayPrecisionTimestamp(publishedOn: string): string {
  const timestamp = `${publishedOn}T12:00:00Z`;
  if (!/^\d{4}-\d{2}-\d{2}T12:00:00Z$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`invalid day-precision publication date: ${publishedOn}`);
  }
  return timestamp;
}

/** Project persisted source observations once, preserving database order and native precision. */
export function syndicationFeed(source: PersistedSourceSummary, sourceEntries: SourceEntryQueryResult[], generatedAt?: string): SyndicationFeed {
  const entries = sourceEntries.map((sourceEntry): SyndicationEntry => {
    const linkOnly = sourceEntry.contentStatus === "link-only";
    const social = sourceEntry.social;
    const publishedOn = social ? social.publicationTime.publishedOn : sourceEntry.publishedOn;
    const publishedAt = social && social.publicationTime.precision !== "day"
      ? social.publicationTime.normalizedAt ?? undefined
      : publishedOn === null ? undefined : dayPrecisionTimestamp(publishedOn);
    const socialContentText = social ? [
      "Only link metadata is published; open the original item.",
      ...(social.role === "relay" || social.attribution.relationship === "relay"
        ? ["Relayed publication; original authorship is not implied."] : []),
      ...(social.attribution.relationship === "unknown"
        ? ["Original authorship is unknown."]
        : social.attribution.verification !== "verified"
          ? ["Original authorship is not verified."] : []),
    ].join(" ") : linkOnlyContentText;
    return {
      id: `${encodeURIComponent(sourceEntry.sourceId)}:${encodeURIComponent(sourceEntry.sourceItemId)}`,
      url: sourceEntry.url,
      title: sourceEntry.title,
      publishedOn,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      updatedAt: rfc3339(sourceEntry.modifiedAt ?? sourceEntry.provenance.fetchedAt),
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
      bodyText: linkOnly ? socialContentText : sourceEntry.bodyText,
      attachments: linkOnly ? [] : sourceEntry.attachments.map((attachment) => ({
        url: attachment.url,
        title: attachment.title,
        mimeType: mimeType(attachment.url, attachment.title, attachment.mediaType),
      })),
      sourceId: sourceEntry.sourceId,
      sourceName: sourceEntry.sourceName,
      organization: sourceEntry.organization,
      contentSha256: sourceEntry.provenance.contentSha256,
      ...(social ? { social } : {}),
    };
  });
  const changedAt = source.socialPublication ? rfc3339(source.socialPublication.changedAt) : "";
  const updatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, changedAt);
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
