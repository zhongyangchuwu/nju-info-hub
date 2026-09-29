import * as cheerio from "cheerio";
import { normalizePublicationDate } from "@nju-info/core";
import type {
  DiscoveredItem,
  DiscoveryPage,
  JobPortalRecruitmentSourceConfig,
  ParsedNotice,
  RawDocument,
} from "@nju-info/core";
import { normalizeText, resolveHttpUrl } from "./html-notice.js";

const RECRUITMENT_API_PATH = "/api/career/job/recruitments";
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

interface JobPortalPage {
  size: number;
  number: number;
  totalElements: number;
  totalPages: number;
}

interface RecruitmentRecord {
  id: string;
  theme: string;
  intro?: string;
  email?: string;
  phone?: string;
  website?: string;
  deadline?: string;
  enabled: boolean;
  applyAt: string;
  status: string;
  positions?: unknown;
  company?: unknown;
}
function pageNumberFromUrl(url: string): number {
  const zeroBased = Number(new URL(url).searchParams.get("page"));
  if (!Number.isInteger(zeroBased) || zeroBased < 0) {
    throw new Error(`invalid recruitment page number: ${url}`);
  }
  return zeroBased + 1;
}

function publicationDate(value: string, sourceId: string): string {
  const match = value.match(DATE_RE)?.[0];
  if (!match || normalizePublicationDate(match) === null) {
    throw new Error(`invalid recruitment publication date for ${sourceId}: ${value}`);
  }
  return match;
}

function recruitmentRecord(
  value: unknown,
  source: JobPortalRecruitmentSourceConfig,
  rawUrl: string,
): RecruitmentRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid recruitment record for ${source.id}: ${rawUrl}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error(`invalid recruitment id for ${source.id}: ${rawUrl}`);
  }
  if (typeof record.theme !== "string" || !normalizeText(record.theme)) {
    throw new Error(`invalid recruitment theme for ${source.id}: ${rawUrl}`);
  }
  if (record.status !== "PUBLISHED" || record.enabled !== true) {
    throw new Error(
      `unexpected recruitment visibility for ${source.id}: ${record.id}`,
    );
  }
  if (typeof record.applyAt !== "string") {
    throw new Error(`missing recruitment applyAt for ${source.id}: ${record.id}`);
  }
  publicationDate(record.applyAt, source.id);
  return {
    id: record.id,
    theme: normalizeText(record.theme),
    ...(typeof record.intro === "string" ? { intro: record.intro } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
    ...(typeof record.phone === "string" ? { phone: record.phone } : {}),
    ...(typeof record.website === "string" ? { website: record.website } : {}),
    ...(typeof record.deadline === "string" ? { deadline: record.deadline } : {}),
    enabled: true,
    applyAt: record.applyAt,
    status: "PUBLISHED",
    positions: record.positions,
    company: record.company,
  };
}
function pageMetadata(value: unknown, sourceId: string, rawUrl: string): JobPortalPage {
  if (typeof value !== "object" || value === null) {
    throw new Error(`missing recruitment page metadata for ${sourceId}: ${rawUrl}`);
  }
  const page = value as Record<string, unknown>;
  const result = {
    size: Number(page.size),
    number: Number(page.number),
    totalElements: Number(page.totalElements),
    totalPages: Number(page.totalPages),
  };
  if (
    !Number.isInteger(result.size) || result.size <= 0 ||
    !Number.isInteger(result.number) || result.number < 0 ||
    !Number.isInteger(result.totalElements) || result.totalElements < 0 ||
    !Number.isInteger(result.totalPages) || result.totalPages <= 0
  ) {
    throw new Error(`invalid recruitment page metadata for ${sourceId}: ${rawUrl}`);
  }
  return result;
}

export function jobPortalRecruitmentPageUrl(
  source: JobPortalRecruitmentSourceConfig,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
    throw new Error(`recruitment page number must be positive: ${pageNumber}`);
  }
  const url = new URL(RECRUITMENT_API_PATH, source.url);
  url.searchParams.set("page", String(pageNumber - 1));
  url.searchParams.set("size", String(source.adapter.pageSize));
  return url.toString();
}

export function jobPortalRecruitmentDetailUrl(
  source: JobPortalRecruitmentSourceConfig,
  sourceItemId: string,
): string {
  return new URL(
    `${RECRUITMENT_API_PATH}/${encodeURIComponent(sourceItemId)}`,
    source.url,
  ).toString();
}

function publicRecruitmentUrl(
  source: JobPortalRecruitmentSourceConfig,
  sourceItemId: string,
): string {
  const url = new URL("/career/jobs-v2", source.url);
  url.searchParams.set("recruitmentId", sourceItemId);
  return url.toString();
}
export function discoverJobPortalRecruitmentPage(
  raw: RawDocument,
  source: JobPortalRecruitmentSourceConfig,
): DiscoveryPage {
  let value: unknown;
  try {
    value = JSON.parse(raw.body);
  } catch (error) {
    throw new Error(`invalid recruitment JSON for ${source.id}: ${raw.url}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid recruitment response for ${source.id}: ${raw.url}`);
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.content)) {
    throw new Error(`missing recruitment content for ${source.id}: ${raw.url}`);
  }
  const page = pageMetadata(response.page, source.id, raw.url);
  const currentPage = pageNumberFromUrl(raw.url);
  if (page.number !== currentPage - 1) {
    throw new Error(`recruitment page mismatch for ${source.id}: ${raw.url}`);
  }
  if (response.content.length > source.adapter.pageSize) {
    throw new Error(`recruitment page exceeds configured size for ${source.id}`);
  }
  if (currentPage === 1 && response.content.length === 0) {
    throw new Error(`empty first recruitment page for ${source.id}: ${raw.url}`);
  }

  const seenIds = new Set<string>();
  const items = response.content.map((value) => {
    const record = recruitmentRecord(value, source, raw.url);
    if (seenIds.has(record.id)) {
      throw new Error(`duplicate recruitment id ${record.id} for ${source.id}`);
    }
    seenIds.add(record.id);
    return {
      sourceId: source.id,
      sourceItemId: record.id,
      url: publicRecruitmentUrl(source, record.id),
      acquisitionKind: "job-portal-recruitment",
      title: record.theme,
      publishedAtRaw: publicationDate(record.applyAt, source.id),
    } satisfies DiscoveredItem;
  });

  return {
    items,
    currentPage,
    totalPages: page.totalPages,
    ...(currentPage < page.totalPages
      ? { nextPageUrl: jobPortalRecruitmentPageUrl(source, currentPage + 1) }
      : {}),
  };
}
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plainField(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return `<p><strong>${escapeHtml(label)}：</strong>${escapeHtml(value.trim())}</p>`;
}

function normalizeRichHtml(value: string, baseUrl: string): string {
  if (!value.trim()) return "";
  const $ = cheerio.load(value);
  const body = $("body");
  for (const attribute of ["href", "src"] as const) {
    body.find(`[${attribute}]`).each((_, element) => {
      const href = $(element).attr(attribute);
      if (!href || href.startsWith("#")) return;
      const absolute = resolveHttpUrl(baseUrl, href);
      if (absolute) $(element).attr(attribute, absolute.toString());
    });
  }
  return body.html() ?? "";
}

function companyName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? normalizeText(name) : undefined;
}
function positionHtml(value: unknown, index: number): string {
  if (typeof value !== "object" || value === null) return "";
  const row = value as Record<string, unknown>;
  const position = typeof row.position === "object" && row.position !== null
    ? row.position as Record<string, unknown>
    : {};
  const name = typeof position.name === "string" && position.name.trim()
    ? normalizeText(position.name)
    : `岗位 ${index + 1}`;
  const region = typeof row.region === "object" && row.region !== null
    ? row.region as Record<string, unknown>
    : {};
  const location = ["province", "city", "district"]
    .map((key) => region[key])
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" / ");

  return [
    `<section><h3>${escapeHtml(name)}</h3>`,
    plainField("学历", position.education),
    plainField("专业", position.major),
    plainField("薪资", row.salary),
    plainField("地点", location),
    typeof row.count === "number" && Number.isFinite(row.count)
      ? `<p><strong>人数：</strong>${row.count}</p>`
      : "",
    plainField("招聘条件", row.recruitmentCondition),
    plainField("其他要求", row.otherRequirement),
    plainField("福利", row.welfare),
    "</section>",
  ].join("");
}

export function parseJobPortalRecruitmentNotice(
  raw: RawDocument,
  source: JobPortalRecruitmentSourceConfig,
  discovered: DiscoveredItem,
): ParsedNotice {
  let value: unknown;
  try {
    value = JSON.parse(raw.body);
  } catch (error) {
    throw new Error(`invalid recruitment detail JSON for ${source.id}: ${raw.url}`, {
      cause: error,
    });
  }
  const record = recruitmentRecord(value, source, raw.url);
  if (record.id !== discovered.sourceItemId) {
    throw new Error(
      `recruitment detail id mismatch for ${source.id}: expected ${discovered.sourceItemId}, got ${record.id}`,
    );
  }
  if (record.positions !== undefined && !Array.isArray(record.positions)) {
    throw new Error(`invalid recruitment positions for ${source.id}: ${record.id}`);
  }
  const intro = record.intro ? normalizeRichHtml(record.intro, source.url) : "";
  const positions = Array.isArray(record.positions)
    ? record.positions.map(positionHtml).join("")
    : "";
  const organization = companyName(record.company);
  const summary = [
    organization ? plainField("单位", organization) : "",
    plainField("投递截止", record.deadline),
    plainField("邮箱", record.email),
    plainField("电话", record.phone),
    plainField("网站", record.website),
  ].join("");
  const bodyHtml = [
    summary,
    intro ? `<section><h3>招聘简介</h3>${intro}</section>` : "",
    positions ? `<section><h3>招聘岗位</h3>${positions}</section>` : "",
  ].join("");
  const $ = cheerio.load(bodyHtml);
  const publishedAtRaw = publicationDate(record.applyAt, source.id);

  return {
    sourceId: source.id,
    sourceItemId: record.id,
    url: discovered.url,
    title: record.theme,
    publishedAtRaw,
    publishedOn: normalizePublicationDate(publishedAtRaw),
    bodyText: normalizeText($("body").text()),
    bodyHtml: $("body").html() ?? "",
    attachments: [],
    provenance: {
      fetchedAt: raw.fetchedAt,
      contentSha256: raw.sha256,
    },
  };
}
