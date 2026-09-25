import { resolve } from "node:path";
import { InfoHubDatabase, type DatabaseStats } from "@nju-info/db";
import {
  RestrictedDetailError,
  discoverWebPlusPage,
  fetchRawDocument,
  orderDiscoveredItemsByPublicationRecency,
  parseWebPlusNotice,
} from "@nju-info/collector";
import type {
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  WebPlusSourceConfig,
} from "@nju-info/core";
import { UnsupportedDetailAcquisitionError, fetchWebPlusDetail } from "./detail-acquisition.js";

export interface IngestSummary {
  sourceId: string;
  databasePath: string;
  pagesVisited: number;
  itemsDiscovered: number;
  noticesIngested: number;
  insertedRevisions: number;
  unchangedRevisions: number;
  stats: DatabaseStats;
}

export interface DiscoverPagesOptions {
  maxPages: number;
  recentLimit?: number;
  onPage?: (rawDocument: RawDocument) => void;
  onCandidate?: (item: DiscoveredItem, listRaw: RawDocument) => Promise<boolean>;
}

export async function discoverPages(
  source: WebPlusSourceConfig,
  options: DiscoverPagesOptions,
): Promise<{
  pagesVisited: number;
  items: DiscoveredItem[];
  candidatesConsidered: number;
}> {
  const firstListRawByUrl = new Map<string, RawDocument>();
  const items = new Map<string, DiscoveredItem>();
  const seenPages = new Set<string>();
  let pageUrl: string | undefined = source.url;
  let pagesVisited = 0;
  let reachedRecentLimit = false;
  const attempted = new Set<string>();
  let usableCount = 0;

  const processCandidates = async (): Promise<boolean> => {
    if (!options.onCandidate) return false;
    for (const item of orderDiscoveredItemsByPublicationRecency([...items.values()])) {
      if (attempted.has(item.url)) continue;
      attempted.add(item.url);
      const listRaw = firstListRawByUrl.get(item.url);
      if (!listRaw) throw new Error(`missing list-page provenance for ${item.url}`);
      if (await options.onCandidate(item, listRaw)) usableCount += 1;
      if (usableCount === options.recentLimit) return true;
    }
    return false;
  };

  while (pageUrl && pagesVisited < options.maxPages && !seenPages.has(pageUrl)) {
    seenPages.add(pageUrl);
    const raw = await fetchRawDocument(source.id, pageUrl);
    options.onPage?.(raw);
    const page = discoverWebPlusPage(raw, source);
    for (const item of page.items) {
      if (!items.has(item.url)) firstListRawByUrl.set(item.url, raw);
      items.set(item.url, item);
    }
    pagesVisited += 1;
    pageUrl = page.nextPageUrl;

    if (options.recentLimit !== undefined && items.size >= options.recentLimit) {
      if (reachedRecentLimit) {
        if (!options.onCandidate || (await processCandidates())) break;
      } else {
        reachedRecentLimit = true;
      }
    }
  }

  if (
    options.onCandidate &&
    options.recentLimit !== undefined &&
    usableCount < options.recentLimit
  ) {
    await processCandidates();
  }

  const sourceOrderedItems = [...items.values()];
  return {
    pagesVisited,
    candidatesConsidered: attempted.size,
    items: options.recentLimit === undefined
      ? sourceOrderedItems
      : orderDiscoveredItemsByPublicationRecency(sourceOrderedItems).slice(
          0,
          options.onCandidate ? undefined : options.recentLimit,
        ),
  };
}

export async function collectNotices(
  source: WebPlusSourceConfig,
  limit: number,
  onPage?: (raw: RawDocument) => void,
  onNotice?: (raw: RawDocument, notice: ParsedNotice) => void,
  onCandidate?: (item: DiscoveredItem, listRaw: RawDocument) => void,
): Promise<{
  pagesVisited: number;
  itemsDiscovered: number;
  notices: ParsedNotice[];
}> {
  const notices: ParsedNotice[] = [];
  const { pagesVisited, candidatesConsidered } = await discoverPages(source, {
    maxPages: 100,
    recentLimit: limit,
    ...(onPage ? { onPage } : {}),
    onCandidate: async (item, listRaw) => {
      onCandidate?.(item, listRaw);
      try {
        const detailRaw = await fetchWebPlusDetail(item);
        const notice = parseWebPlusNotice(detailRaw, source, item);
        onNotice?.(detailRaw, notice);
        notices.push(notice);
        return true;
      } catch (error) {
        if (error instanceof RestrictedDetailError) {
          console.error(
            `skipping restricted detail ${source.id} ${item.url}: ${error.restrictionClass}`,
          );
          return false;
        }
        if (error instanceof UnsupportedDetailAcquisitionError) {
          console.error(
            `skipping unsupported detail ${error.sourceId} ${error.url}: ${error.acquisitionKind}`,
          );
          return false;
        }
        throw error;
      }
    },
  });
  return { pagesVisited, itemsDiscovered: candidatesConsidered, notices };
}

export async function ingestSource(
  source: WebPlusSourceConfig,
  databasePath: string,
  itemLimit: number,
): Promise<IngestSummary> {
  const resolvedDatabasePath = resolve(databasePath);
  const database = new InfoHubDatabase(resolvedDatabasePath);

  try {
    let insertedRevisions = 0;
    let unchangedRevisions = 0;
    const { pagesVisited, itemsDiscovered, notices } = await collectNotices(
      source,
      itemLimit,
      (rawDocument) => database.persistRawDocument(source, rawDocument),
      (detailRaw, notice) => {
        const result = database.ingestNotice(source, detailRaw, notice);
        if (result.insertedRevision) insertedRevisions += 1;
        else unchangedRevisions += 1;
      },
      (item, listRaw) => database.observeSourceItem(source, listRaw, item),
    );

    return {
      sourceId: source.id,
      databasePath: resolvedDatabasePath,
      pagesVisited,
      itemsDiscovered,
      noticesIngested: notices.length,
      insertedRevisions,
      unchangedRevisions,
      stats: database.stats(),
    };
  } finally {
    database.close();
  }
}
