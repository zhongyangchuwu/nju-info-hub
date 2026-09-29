import * as cheerio from "cheerio";
import type {
  BoshanSourceConfig,
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
} from "@nju-info/core";
import {
  DATE_RE,
  assertUnrestrictedDetail,
  normalizeText,
  parseHtmlNotice,
  resolveHttpUrl,
} from "./html-notice.js";

const BOSHAN_LIST_PATH = "/njdx/openapi/t/info/list.do";
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface BoshanListRecord {
  iid: number;
  channelid: number;
  title: string;
  releasetime: number;
  url: string;
}

function base64(value: number): string {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function boshanPageNumber(url: string): number {
  const encoded = new URL(url).searchParams.get("pageno");
  if (!encoded) throw new Error(`missing Boshan page number: ${url}`);
  const pageNumber = Number(Buffer.from(encoded, "base64").toString("utf8"));
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
    throw new Error(`invalid Boshan page number: ${url}`);
  }
  return pageNumber;
}

function boshanRecord(
  value: unknown,
  source: BoshanSourceConfig,
  rawUrl: string,
): BoshanListRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid Boshan list record for ${source.id}: ${rawUrl}`);
  }
  const record = value as Record<string, unknown>;
  const iid = record.iid;
  const channelId = record.channelid;
  const title = record.title;
  const releaseTime = record.releasetime;
  const url = record.url;
  if (!Number.isInteger(iid) || Number(iid) <= 0) {
    throw new Error(`invalid Boshan iid for ${source.id}: ${rawUrl}`);
  }
  if (channelId !== source.adapter.channelId) {
    throw new Error(
      `Boshan channel mismatch for ${source.id}: expected ${source.adapter.channelId}, got ${String(channelId)}`,
    );
  }
  if (typeof title !== "string" || !normalizeText(title)) {
    throw new Error(`invalid Boshan title for ${source.id}: ${rawUrl}`);
  }
  if (!Number.isFinite(releaseTime)) {
    throw new Error(`invalid Boshan release time for ${source.id}: ${rawUrl}`);
  }
  if (typeof url !== "string" || !resolveHttpUrl(source.url, url)) {
    throw new Error(`invalid Boshan detail URL for ${source.id}: ${rawUrl}`);
  }
  return {
    iid: Number(iid),
    channelid: source.adapter.channelId,
    title: normalizeText(title),
    releasetime: Number(releaseTime),
    url,
  };
}

export function boshanPageUrl(
  source: BoshanSourceConfig,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
    throw new Error(`Boshan page number must be a positive integer: ${pageNumber}`);
  }
  const url = new URL(BOSHAN_LIST_PATH, source.url);
  url.searchParams.set("channelid", base64(source.adapter.channelId));
  url.searchParams.set("pageno", base64(pageNumber));
  url.searchParams.set("pagesize", base64(source.adapter.pageSize));
  return url.toString();
}

export function discoverBoshanPage(
  raw: RawDocument,
  source: BoshanSourceConfig,
): DiscoveryPage {
  let value: unknown;
  try {
    value = JSON.parse(raw.body);
  } catch (error) {
    throw new Error(`invalid Boshan JSON for ${source.id}: ${raw.url}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid Boshan response for ${source.id}: ${raw.url}`);
  }
  const records = (value as Record<string, unknown>).infolist;
  if (!Array.isArray(records)) {
    throw new Error(`missing Boshan infolist for ${source.id}: ${raw.url}`);
  }
  if (records.length > source.adapter.pageSize) {
    throw new Error(
      `Boshan page exceeds configured size for ${source.id}: ${records.length} > ${source.adapter.pageSize}`,
    );
  }

  const currentPage = boshanPageNumber(raw.url);
  if (currentPage === 1 && records.length === 0) {
    throw new Error(`empty first Boshan page for ${source.id}: ${raw.url}`);
  }

  const sourceUrl = new URL(source.url);
  const seenIds = new Set<number>();
  const items = records.map((value) => {
    const record = boshanRecord(value, source, raw.url);
    if (seenIds.has(record.iid)) {
      throw new Error(`duplicate Boshan iid ${record.iid} for ${source.id}: ${raw.url}`);
    }
    seenIds.add(record.iid);

    const target = new URL(record.url, source.url);
    if (target.hostname === sourceUrl.hostname) {
      target.protocol = sourceUrl.protocol;
      target.port = sourceUrl.port;
      target.pathname = target.pathname.replace(/\/{2,}/g, "/");
    }
    let acquisitionKind: DiscoveredItem["acquisitionKind"];
    if (
      target.hostname === "mp.weixin.qq.com" &&
      (target.pathname === "/s" || target.pathname.startsWith("/s/"))
    ) {
      acquisitionKind = "public-wechat";
    } else if (target.hostname === sourceUrl.hostname) {
      acquisitionKind = "boshan-detail";
    } else {
      acquisitionKind = "external-public";
    }

    const publishedAtRaw = SHANGHAI_DATE.format(new Date(record.releasetime));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedAtRaw)) {
      throw new Error(`invalid Boshan publication date for ${source.id}: ${record.releasetime}`);
    }
    return {
      sourceId: source.id,
      sourceItemId: String(record.iid),
      url: target.toString(),
      acquisitionKind,
      title: record.title,
      publishedAtRaw,
    } satisfies DiscoveredItem;
  });

  return {
    items,
    currentPage,
    ...(records.length === source.adapter.pageSize
      ? { nextPageUrl: boshanPageUrl(source, currentPage + 1) }
      : {}),
  };
}

export function parseBoshanNotice(
  raw: RawDocument,
  source: BoshanSourceConfig,
  discovered: DiscoveredItem,
): ParsedNotice {
  const $ = cheerio.load(raw.body);
  assertUnrestrictedDetail($, raw, discovered);
  const metaTitle = normalizeText(
    $('meta[name="ArticleTitle"]').attr("content") ?? "",
  );
  const metaPublishedAt = normalizeText(
    $('meta[name="PubDate"]').attr("content") ?? "",
  );
  const publishedAtRaw =
    metaPublishedAt.match(DATE_RE)?.[0] ?? discovered.publishedAtRaw;
  return parseHtmlNotice({
    $,
    raw,
    sourceId: source.id,
    discovered,
    title: metaTitle,
    ...(publishedAtRaw ? { publishedAtRaw } : {}),
    content: $(source.adapter.selectors.content).first(),
    attachmentLinkSelector: 'a[href*="/DFS/"][href*="/file/"]',
  });
}
