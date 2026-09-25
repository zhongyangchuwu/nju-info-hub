import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { InfoHubDatabase, type DatabaseStats } from "@nju-info/db";
import {
  RestrictedDetailError,
  discoverWebPlusItems,
  discoverWebPlusPage,
  fetchRawDocument,
  loadSourceDirectory,
  orderDiscoveredItemsByPublicationRecency,
  parseWebPlusNotice,
} from "@nju-info/collector";
import type {
  DiscoveredItem,
  ParsedNotice,
  RawDocument,
  SourceConfig,
  WebPlusSourceConfig,
} from "@nju-info/core";
import { UnsupportedDetailAcquisitionError, fetchWebPlusDetail } from "./detail-acquisition.js";

function sourceDirectory(): string {
  return fileURLToPath(new URL("../../../sources/nju/", import.meta.url));
}

async function loadSources(): Promise<SourceConfig[]> {
  return loadSourceDirectory(sourceDirectory());
}

function findSource(sources: SourceConfig[], id: string): SourceConfig {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error(`unknown source: ${id}`);
  return source;
}

function requireWebPlus(source: SourceConfig): WebPlusSourceConfig {
  if (source.adapter.type !== "webplus") {
    throw new Error(`${source.id} is not a WebPlus source yet`);
  }
  return source as WebPlusSourceConfig;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got: ${value}`);
  }
  return parsed;
}
interface IngestSummary {
  sourceId: string;
  databasePath: string;
  pagesVisited: number;
  itemsDiscovered: number;
  noticesIngested: number;
  insertedRevisions: number;
  unchangedRevisions: number;
  stats: DatabaseStats;
}

interface DiscoverPagesOptions {
  maxPages: number;
  recentLimit?: number;
  onPage?: (rawDocument: RawDocument) => void;
  onCandidate?: (item: DiscoveredItem, listRaw: RawDocument) => Promise<boolean>;
}

async function discoverPages(
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
    for (const item of orderDiscoveredItemsByPublicationRecency([
      ...items.values(),
    ])) {
      if (attempted.has(item.url)) continue;
      attempted.add(item.url);
      const listRaw = firstListRawByUrl.get(item.url);
      if (!listRaw) throw new Error(`missing list-page provenance for ${item.url}`);
      if (await options.onCandidate(item, listRaw)) usableCount += 1;
      if (usableCount === options.recentLimit) return true;
    }
    return false;
  };

  while (
    pageUrl &&
    pagesVisited < options.maxPages &&
    !seenPages.has(pageUrl)
  ) {
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
    items:
      options.recentLimit === undefined
        ? sourceOrderedItems
        : orderDiscoveredItemsByPublicationRecency(sourceOrderedItems).slice(
            0,
            options.onCandidate ? undefined : options.recentLimit,
          ),
  };
}

async function collectNotices(
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

async function ingestSource(
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const [command = "sources", sourceId, thirdArg, fourthArg] = args;
  const sources = await loadSources();

  if (command === "sources") {
    console.log(
      JSON.stringify(
        sources.map(({ id, name, url, adapter }) => ({
          id,
          name,
          url,
          adapter: adapter.type,
        })),
        null,
        2,
      ),
    );
    return;
  }

  const sourceCommands: Record<string, true> = {
    discover: true,
    "discover-pages": true,
    fetch: true,
    ingest: true,
  };
  if (!sourceCommands[command]) {
    throw new Error(`unknown command: ${command}`);
  }

  if (!sourceId) throw new Error(`usage: ${command} <source-id> [limit]`);
  const source = requireWebPlus(findSource(sources, sourceId));

  if (command === "ingest") {
    if (!thirdArg) {
      throw new Error("usage: ingest <source-id> <database-path> [limit]");
    }
    const result = await ingestSource(
      source,
      thirdArg,
      positiveInteger(fourthArg, 10),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "discover-pages") {
    const result = await discoverPages(source, {
      maxPages: positiveInteger(thirdArg, 2),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "discover") {
    const listRaw = await fetchRawDocument(source.id, source.url);
    const items = discoverWebPlusItems(listRaw, source);
    console.log(
      JSON.stringify(items.slice(0, positiveInteger(thirdArg, 10)), null, 2),
    );
    return;
  }

  const limit = positiveInteger(thirdArg, 1);
  const { notices } = await collectNotices(source, limit);
  console.log(JSON.stringify(notices, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
