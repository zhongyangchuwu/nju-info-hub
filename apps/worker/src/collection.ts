import { resolve } from "node:path";
import { InfoHubDatabase, type DatabaseStats } from "@nju-info/db";
import {
  RestrictedDetailError,
  discoverSourcePage,
  fetchRawDocument,
  initialSourcePageUrl,
  orderDiscoveredItemsByPublicationRecency,
  parseSourceNotice,
} from "@nju-info/collector";
import type {
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";
import {
  UnsupportedDetailAcquisitionError,
  fetchSourceDetail,
} from "./detail-acquisition.js";

export interface IngestSummary {
  sourceId: string;
  databasePath: string;
  pagesVisited: number;
  itemsObserved: number;
  noticesIngested: number;
  insertedRevisions: number;
  unchangedRevisions: number;
  stats: DatabaseStats;
}

export interface DiscoverPagesOptions {
  maxPages: number;
  maxOverlapSearchPages?: number;
  recentLimit?: number;
  knownSourceItemIds?: ReadonlySet<string>;
  onPage?: (rawDocument: RawDocument) => void;
  onItem?: (item: DiscoveredItem, listRaw: RawDocument) => void;
  onCandidate?: (item: DiscoveredItem, listRaw: RawDocument) => Promise<void>;
}

/**
 * Discover the source's current update frontier.
 *
 * Bootstrap runs keep a bounded recent window plus one lookahead page. Once the
 * database has history, discovery stops after the first page containing any
 * known source item and one additional observation-only lookahead page. If no
 * overlap is found within the overlap-search cap, fail before observing or
 * enriching items. Unseen items through the overlap page are selected, while
 * `recentLimit` also refreshes that many of the newest known items so edits can
 * still create new revisions.
 */
export async function discoverPages(
  source: SourceConfig,
  options: DiscoverPagesOptions,
): Promise<{
  pagesVisited: number;
  items: DiscoveredItem[];
}> {
  const firstListRawByUrl = new Map<string, RawDocument>();
  const items = new Map<string, DiscoveredItem>();
  const incrementalCandidateUrls = new Set<string>();
  const seenPages = new Set<string>();
  const knownSourceItemIds = options.knownSourceItemIds ?? new Set<string>();
  const incremental = knownSourceItemIds.size > 0;
  const maxOverlapSearchPages = options.maxOverlapSearchPages ?? 10;
  let pageUrl: string | undefined = initialSourcePageUrl(source);
  let pagesVisited = 0;
  let reachedBootstrapLimit = false;
  let foundOverlap = false;
  while (pageUrl && pagesVisited < options.maxPages && !seenPages.has(pageUrl)) {
    seenPages.add(pageUrl);
    const raw = await fetchRawDocument(source.id, pageUrl);
    options.onPage?.(raw);
    const page = discoverSourcePage(raw, source);
    let pageHasKnownItem = false;
    const isIncrementalLookahead = incremental && foundOverlap;
    for (const item of page.items) {
      if (!items.has(item.url)) firstListRawByUrl.set(item.url, raw);
      items.set(item.url, item);
      if (incremental && !isIncrementalLookahead) incrementalCandidateUrls.add(item.url);
      if (knownSourceItemIds.has(item.sourceItemId)) pageHasKnownItem = true;
    }
    pagesVisited += 1;
    pageUrl = page.nextPageUrl;

    if (incremental) {
      if (foundOverlap) break;
      if (pageHasKnownItem) {
        foundOverlap = true;
        continue;
      }
      if (pagesVisited >= maxOverlapSearchPages) break;
      continue;
    }

    if (options.recentLimit !== undefined && items.size >= options.recentLimit) {
      if (reachedBootstrapLimit || !pageUrl) break;
      reachedBootstrapLimit = true;
    }
  }

  if (incremental && !foundOverlap) {
    throw new Error(
      `${source.id}: no known source-item overlap after ${pagesVisited} list pages (overlap-search cap ${maxOverlapSearchPages}, maxPages ${options.maxPages}); refusing to observe or enrich without a history boundary`,
    );
  }

  const sourceOrderedItems = [...items.values()];
  if (options.onItem) {
    for (const item of sourceOrderedItems) {
      const listRaw = firstListRawByUrl.get(item.url);
      if (!listRaw) throw new Error(`missing list-page provenance for ${item.url}`);
      options.onItem(item, listRaw);
    }
  }

  let selectedItems: DiscoveredItem[];
  const candidateItems = incremental
    ? sourceOrderedItems.filter((item) => incrementalCandidateUrls.has(item.url))
    : sourceOrderedItems;
  if (options.recentLimit === undefined) {
    selectedItems = candidateItems;
  } else {
    const ordered = orderDiscoveredItemsByPublicationRecency(candidateItems);
    if (!incremental) {
      selectedItems = ordered.slice(0, options.recentLimit);
    } else {
      let refreshedKnownItems = 0;
      selectedItems = ordered.filter((item) => {
        if (!knownSourceItemIds.has(item.sourceItemId)) return true;
        if (refreshedKnownItems >= options.recentLimit!) return false;
        refreshedKnownItems += 1;
        return true;
      });
    }
  }

  if (options.onCandidate) {
    for (const item of selectedItems) {
      const listRaw = firstListRawByUrl.get(item.url);
      if (!listRaw) throw new Error(`missing list-page provenance for ${item.url}`);
      await options.onCandidate(item, listRaw);
    }
  }

  return { pagesVisited, items: selectedItems };
}

export async function collectNotices(
  source: SourceConfig,
  limit: number,
  onPage?: (raw: RawDocument) => void,
  onNotice?: (raw: RawDocument, notice: ParsedNotice) => void,
  onObservedItem?: (item: DiscoveredItem, listRaw: RawDocument) => void,
  knownSourceItemIds?: ReadonlySet<string>,
): Promise<{
  pagesVisited: number;
  itemsObserved: number;
  notices: ParsedNotice[];
}> {
  const notices: ParsedNotice[] = [];
  let itemsObserved = 0;
  const { pagesVisited } = await discoverPages(source, {
    maxPages: 100,
    recentLimit: limit,
    ...(knownSourceItemIds ? { knownSourceItemIds } : {}),
    ...(onPage ? { onPage } : {}),
    onItem: (item, listRaw) => {
      itemsObserved += 1;
      onObservedItem?.(item, listRaw);
    },
    onCandidate: async (item) => {
      try {
        const detailRaw = await fetchSourceDetail(item);
        const notice = parseSourceNotice(detailRaw, source, item);
        onNotice?.(detailRaw, notice);
        notices.push(notice);
      } catch (error) {
        if (error instanceof RestrictedDetailError) {
          console.error(
            `skipping restricted detail ${source.id} ${item.url}: ${error.restrictionClass}`,
          );
          return;
        }
        if (error instanceof UnsupportedDetailAcquisitionError) {
          console.error(
            `skipping unsupported detail ${error.sourceId} ${error.url}: ${error.acquisitionKind}`,
          );
          return;
        }
        throw error;
      }
    },
  });
  return { pagesVisited, itemsObserved, notices };
}

export async function ingestSource(
  source: SourceConfig,
  databasePath: string,
  recentItemLimit: number,
): Promise<IngestSummary> {
  const resolvedDatabasePath = resolve(databasePath);
  const database = new InfoHubDatabase(resolvedDatabasePath);

  try {
    let insertedRevisions = 0;
    let unchangedRevisions = 0;
    const knownSourceItemIds = new Set(database.listKnownSourceItemIds(source.id));
    const { pagesVisited, itemsObserved, notices } = await collectNotices(
      source,
      recentItemLimit,
      (rawDocument) => database.persistRawDocument(source, rawDocument),
      (detailRaw, notice) => {
        const result = database.ingestNotice(source, detailRaw, notice);
        if (result.insertedRevision) insertedRevisions += 1;
        else unchangedRevisions += 1;
      },
      (item, listRaw) => database.observeSourceItem(source, listRaw, item),
      knownSourceItemIds,
    );

    return {
      sourceId: source.id,
      databasePath: resolvedDatabasePath,
      pagesVisited,
      itemsObserved,
      noticesIngested: notices.length,
      insertedRevisions,
      unchangedRevisions,
      stats: database.stats(),
    };
  } finally {
    database.close();
  }
}
