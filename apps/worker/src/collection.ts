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
  CollectionPhase,
  CollectionSourceCounts,
  DiscoveryPage,
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";
import { CollectionStageError } from "./diagnostics.js";
import {
  UnsupportedDetailAcquisitionError,
  fetchSourceDetail,
} from "./detail-acquisition.js";

export interface IngestSummary extends CollectionSourceCounts {
  sourceId: string;
  databasePath: string;
  stats: DatabaseStats;
}

type SkippedDetailKind = "restricted" | "unsupported";

function stageFailure(phase: CollectionPhase, cause: unknown): CollectionStageError {
  try {
    if (cause instanceof CollectionStageError) return cause;
  } catch {
    // A hostile proxy is preserved as the original cause below.
  }
  return new CollectionStageError(phase, cause);
}


function warnSkippedDetail(
  error: unknown,
  sourceId: string,
): SkippedDetailKind | undefined {
  let restrictionClass: RestrictedDetailError["restrictionClass"] | undefined;
  let acquisitionKind:
    | UnsupportedDetailAcquisitionError["acquisitionKind"]
    | undefined;
  try {
    if (error instanceof RestrictedDetailError) {
      const candidate = error.restrictionClass;
      if (candidate === "campus-network" || candidate === "authentication") {
        restrictionClass = candidate;
      }
    } else if (error instanceof UnsupportedDetailAcquisitionError) {
      const candidate = error.acquisitionKind;
      if (candidate === "public-wechat" || candidate === "external-public") {
        acquisitionKind = candidate;
      }
    }
  } catch {
    return undefined;
  }

  if (restrictionClass) {
    console.warn(JSON.stringify({
      event: "restricted_detail_skipped",
      sourceId,
      restrictionClass,
    }));
    return "restricted";
  }
  if (acquisitionKind) {
    console.warn(JSON.stringify({
      event: "unsupported_detail_skipped",
      sourceId,
      acquisitionKind,
    }));
    return "unsupported";
  }
  return undefined;
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
async function discoverPagesUnchecked(
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
    const currentPageUrl = pageUrl;
    seenPages.add(currentPageUrl);
    let raw: RawDocument;
    try {
      raw = await fetchRawDocument(source.id, currentPageUrl);
    } catch (error) {
      throw stageFailure("list-fetch", error);
    }
    if (options.onPage) {
      try {
        options.onPage(raw);
      } catch (error) {
        throw stageFailure("persistence", error);
      }
    }
    let page: DiscoveryPage;
    try {
      page = discoverSourcePage(raw, source);
    } catch (error) {
      throw stageFailure("list-parse", error);
    }
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
      try {
        options.onItem(item, listRaw);
      } catch (error) {
        throw stageFailure("persistence", error);
      }
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

export async function discoverPages(
  source: SourceConfig,
  options: DiscoverPagesOptions,
): Promise<{ pagesVisited: number; items: DiscoveredItem[] }> {
  try {
    return await discoverPagesUnchecked(source, options);
  } catch (error) {
    throw stageFailure("discovery", error);
  }
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
  newItemsObserved: number;
  skippedRestricted: number;
  skippedUnsupported: number;
  notices: ParsedNotice[];
}> {
  const notices: ParsedNotice[] = [];
  const newSourceItemIds = new Set<string>();
  let itemsObserved = 0;
  let skippedRestricted = 0;
  let skippedUnsupported = 0;
  const { pagesVisited } = await discoverPages(source, {
    maxPages: 100,
    recentLimit: limit,
    ...(knownSourceItemIds ? { knownSourceItemIds } : {}),
    ...(onPage ? { onPage } : {}),
    onItem: (item, listRaw) => {
      itemsObserved += 1;
      if (!knownSourceItemIds?.has(item.sourceItemId)) {
        newSourceItemIds.add(item.sourceItemId);
      }
      try {
        onObservedItem?.(item, listRaw);
      } catch (error) {
        throw stageFailure("persistence", error);
      }
    },
    onCandidate: async (item) => {
      let detailRaw: RawDocument;
      try {
        detailRaw = await fetchSourceDetail(source, item);
      } catch (error) {
        const skipped = warnSkippedDetail(error, source.id);
        if (skipped === "restricted") {
          skippedRestricted += 1;
          return;
        }
        if (skipped === "unsupported") {
          skippedUnsupported += 1;
          return;
        }
        throw stageFailure("detail-fetch", error);
      }

      let notice: ParsedNotice;
      try {
        notice = parseSourceNotice(detailRaw, source, item);
      } catch (error) {
        const skipped = warnSkippedDetail(error, source.id);
        if (skipped === "restricted") {
          skippedRestricted += 1;
          return;
        }
        if (skipped === "unsupported") {
          skippedUnsupported += 1;
          return;
        }
        throw stageFailure("detail-parse", error);
      }

      try {
        onNotice?.(detailRaw, notice);
      } catch (error) {
        throw stageFailure("persistence", error);
      }
      notices.push(notice);
    },
  });
  return {
    pagesVisited,
    itemsObserved,
    newItemsObserved: newSourceItemIds.size,
    skippedRestricted,
    skippedUnsupported,
    notices,
  };
}

export async function ingestSource(
  source: SourceConfig,
  databasePath: string,
  recentItemLimit: number,
): Promise<IngestSummary> {
  const resolvedDatabasePath = resolve(databasePath);
  let database: InfoHubDatabase | undefined;

  try {
    database = new InfoHubDatabase(resolvedDatabasePath);
    let insertedRevisions = 0;
    let unchangedRevisions = 0;
    const knownSourceItemIds = new Set(database.listKnownSourceItemIds(source.id));
    const {
      pagesVisited,
      itemsObserved,
      newItemsObserved,
      skippedRestricted,
      skippedUnsupported,
      notices,
    } = await collectNotices(
      source,
      recentItemLimit,
      (rawDocument) => database!.persistRawDocument(source, rawDocument),
      (detailRaw, notice) => {
        const result = database!.ingestNotice(source, detailRaw, notice);
        if (result.insertedRevision) insertedRevisions += 1;
        else unchangedRevisions += 1;
      },
      (item, listRaw) => database!.observeSourceItem(source, listRaw, item),
      knownSourceItemIds,
    );

    return {
      sourceId: source.id,
      databasePath: resolvedDatabasePath,
      pagesVisited,
      itemsObserved,
      newItemsObserved,
      noticesIngested: notices.length,
      insertedRevisions,
      unchangedRevisions,
      skippedRestricted,
      skippedUnsupported,
      stats: database.stats(),
    };
  } catch (error) {
    throw stageFailure("persistence", error);
  } finally {
    try {
      database?.close();
    } catch (error) {
      throw stageFailure("persistence", error);
    }
  }
}
