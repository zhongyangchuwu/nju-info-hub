import * as cheerio from "cheerio";
import { normalizePublicationDate } from "@nju-info/core";
import type {
  DiscoveredItem,
  DiscoveryPage,
  JobPortalInformationSourceConfig,
  ParsedNotice,
  RawDocument,
} from "@nju-info/core";
import { normalizeText, resolveHttpUrl } from "./html-notice.js";

const INFORMATION_API_PATH = "/api/career/content/informations";
const PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}/;

interface JobPortalPage {
  size: number;
  number: number;
  totalElements: number;
  totalPages: number;
}

interface JobPortalInformationRecord {
  id: string;
  title: string;
  content?: string;
  type: string;
  status: string;
  attachments?: unknown;
  externalLink?: unknown;
  loginRequired: boolean;
  publishedAt: string;
}
function pageNumberFromUrl(url: string): number {
  const raw = new URL(url).searchParams.get("page");
  const zeroBased = Number(raw);
  if (!Number.isInteger(zeroBased) || zeroBased < 0) {
    throw new Error(`invalid job portal page number: ${url}`);
  }
  return zeroBased + 1;
}

function publicationDate(value: string, sourceId: string): string {
  const match = value.match(PUBLISHED_AT_RE)?.[0];
  if (!match || normalizePublicationDate(match) === null) {
    throw new Error(`invalid job portal publication date for ${sourceId}: ${value}`);
  }
  return match;
}

function informationRecord(
  value: unknown,
  source: JobPortalInformationSourceConfig,
  rawUrl: string,
): JobPortalInformationRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid job portal record for ${source.id}: ${rawUrl}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error(`invalid job portal id for ${source.id}: ${rawUrl}`);
  }
  if (typeof record.title !== "string" || !normalizeText(record.title)) {
    throw new Error(`invalid job portal title for ${source.id}: ${rawUrl}`);
  }
  if (record.type !== source.adapter.contentType) {
    throw new Error(
      `job portal type mismatch for ${source.id}: expected ${source.adapter.contentType}, got ${String(record.type)}`,
    );
  }
  if (record.status !== "PUBLISHED") {
    throw new Error(`unexpected job portal status for ${source.id}: ${String(record.status)}`);
  }
  if (record.loginRequired !== false) {
    throw new Error(`job portal item requires login for ${source.id}: ${record.id}`);
  }
  if (typeof record.publishedAt !== "string") {
    throw new Error(`missing job portal publication date for ${source.id}: ${record.id}`);
  }
  publicationDate(record.publishedAt, source.id);
  return {
    id: record.id,
    title: normalizeText(record.title),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    type: source.adapter.contentType,
    status: "PUBLISHED",
    attachments: record.attachments,
    externalLink: record.externalLink,
    loginRequired: false,
    publishedAt: record.publishedAt,
  };
}

function pageMetadata(value: unknown, sourceId: string, rawUrl: string): JobPortalPage {
  if (typeof value !== "object" || value === null) {
    throw new Error(`missing job portal page metadata for ${sourceId}: ${rawUrl}`);
  }
  const page = value as Record<string, unknown>;
  const result = {
    size: Number(page.size),
    number: Number(page.number),
    totalElements: Number(page.totalElements),
    totalPages: Number(page.totalPages),
  };
  if (!Number.isInteger(result.size) || result.size <= 0 ||
      !Number.isInteger(result.number) || result.number < 0 ||
      !Number.isInteger(result.totalElements) || result.totalElements < 0 ||
      !Number.isInteger(result.totalPages) || result.totalPages <= 0) {
    throw new Error(`invalid job portal page metadata for ${sourceId}: ${rawUrl}`);
  }
  return result;
}
export function jobPortalInformationPageUrl(
  source: JobPortalInformationSourceConfig,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
    throw new Error(`job portal page number must be positive: ${pageNumber}`);
  }
  const url = new URL(INFORMATION_API_PATH, source.url);
  url.searchParams.set("page", String(pageNumber - 1));
  url.searchParams.set("size", String(source.adapter.pageSize));
  url.searchParams.set("type", source.adapter.contentType);
  return url.toString();
}

export function jobPortalInformationDetailUrl(
  source: JobPortalInformationSourceConfig,
  sourceItemId: string,
): string {
  return new URL(
    `${INFORMATION_API_PATH}/${encodeURIComponent(sourceItemId)}`,
    source.url,
  ).toString();
}

function publicInformationUrl(
  source: JobPortalInformationSourceConfig,
  sourceItemId: string,
): string {
  const url = new URL(`/career/info/${encodeURIComponent(sourceItemId)}`, source.url);
  url.searchParams.set("type", source.adapter.contentType);
  return url.toString();
}
export function discoverJobPortalInformationPage(
  raw: RawDocument,
  source: JobPortalInformationSourceConfig,
): DiscoveryPage {
  let value: unknown;
  try {
    value = JSON.parse(raw.body);
  } catch (error) {
    throw new Error(`invalid job portal JSON for ${source.id}: ${raw.url}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid job portal response for ${source.id}: ${raw.url}`);
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.content)) {
    throw new Error(`missing job portal content for ${source.id}: ${raw.url}`);
  }
  const page = pageMetadata(response.page, source.id, raw.url);
  const currentPage = pageNumberFromUrl(raw.url);
  if (page.number !== currentPage - 1) {
    throw new Error(`job portal page mismatch for ${source.id}: ${raw.url}`);
  }
  if (response.content.length > source.adapter.pageSize) {
    throw new Error(`job portal page exceeds configured size for ${source.id}`);
  }
  if (currentPage === 1 && response.content.length === 0) {
    throw new Error(`empty first job portal page for ${source.id}: ${raw.url}`);
  }
  const seenIds = new Set<string>();
  const items = response.content.map((value) => {
    const record = informationRecord(value, source, raw.url);
    if (seenIds.has(record.id)) {
      throw new Error(`duplicate job portal id ${record.id} for ${source.id}`);
    }
    seenIds.add(record.id);

    let url = publicInformationUrl(source, record.id);
    let acquisitionKind: DiscoveredItem["acquisitionKind"] = "job-portal-information";
    if (typeof record.externalLink === "string" && record.externalLink.trim()) {
      const external = resolveHttpUrl(source.url, record.externalLink);
      if (!external) {
        throw new Error(`invalid job portal external link for ${source.id}: ${record.id}`);
      }
      url = external.toString();
      acquisitionKind = "external-public";
    }

    return {
      sourceId: source.id,
      sourceItemId: record.id,
      url,
      acquisitionKind,
      title: record.title,
      publishedAtRaw: publicationDate(record.publishedAt, source.id),
    } satisfies DiscoveredItem;
  });

  return {
    items,
    currentPage,
    totalPages: page.totalPages,
    ...(currentPage < page.totalPages
      ? { nextPageUrl: jobPortalInformationPageUrl(source, currentPage + 1) }
      : {}),
  };
}
function attachmentTitle(url: URL): string {
  const name = url.pathname.split("/").filter(Boolean).at(-1);
  if (!name) return url.toString();
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function parseJobPortalInformationNotice(
  raw: RawDocument,
  source: JobPortalInformationSourceConfig,
  discovered: DiscoveredItem,
): ParsedNotice {
  let value: unknown;
  try {
    value = JSON.parse(raw.body);
  } catch (error) {
    throw new Error(`invalid job portal detail JSON for ${source.id}: ${raw.url}`, {
      cause: error,
    });
  }
  const record = informationRecord(value, source, raw.url);
  if (record.id !== discovered.sourceItemId) {
    throw new Error(
      `job portal detail id mismatch for ${source.id}: expected ${discovered.sourceItemId}, got ${record.id}`,
    );
  }
  if (typeof record.content !== "string" || !record.content.trim()) {
    throw new Error(`missing job portal detail content for ${source.id}: ${record.id}`);
  }
  const $ = cheerio.load(record.content);
  const content = $("body");
  for (const attribute of ["href", "src"] as const) {
    content.find(`[${attribute}]`).each((_, element) => {
      const href = $(element).attr(attribute);
      if (!href || href.startsWith("#")) return;
      const absolute = resolveHttpUrl(source.url, href);
      if (absolute) $(element).attr(attribute, absolute.toString());
    });
  }

  const attachments = new Map<string, { url: string; title: string }>();
  if (record.attachments !== undefined && record.attachments !== null) {
    if (!Array.isArray(record.attachments)) {
      throw new Error(`invalid job portal attachments for ${source.id}: ${record.id}`);
    }
    for (const value of record.attachments) {
      if (typeof value !== "string") {
        throw new Error(`invalid job portal attachment URL for ${source.id}: ${record.id}`);
      }
      const target = resolveHttpUrl(source.url, value);
      if (!target) {
        throw new Error(`invalid job portal attachment URL for ${source.id}: ${record.id}`);
      }
      attachments.set(target.toString(), {
        url: target.toString(),
        title: attachmentTitle(target),
      });
    }
  }
  const publishedAtRaw = publicationDate(record.publishedAt, source.id);
  return {
    sourceId: source.id,
    sourceItemId: record.id,
    url: discovered.url,
    title: record.title,
    publishedAtRaw,
    publishedOn: normalizePublicationDate(publishedAtRaw),
    bodyText: normalizeText(content.text()),
    bodyHtml: content.html() ?? "",
    attachments: [...attachments.values()],
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
