import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { InfoHubDatabase, type DatabaseStats } from "@nju-info/db";
import {
  discoverWebPlusItems,
  discoverWebPlusPage,
  fetchRawDocument,
  loadSourceDirectory,
  orderDiscoveredItemsByPublicationRecency,
  parseWebPlusNotice,
} from "@nju-info/collector";
import type {
  DiscoveredItem,
  RawDocument,
  SourceConfig,
  WebPlusSourceConfig,
} from "@nju-info/core";

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
}

async function discoverPages(
  source: WebPlusSourceConfig,
  options: DiscoverPagesOptions,
): Promise<{
  pagesVisited: number;
  items: DiscoveredItem[];
}> {
  const items = new Map<string, DiscoveredItem>();
  const seenPages = new Set<string>();
  let pageUrl: string | undefined = source.url;
  let pagesVisited = 0;
  let reachedRecentLimit = false;

  while (
    pageUrl &&
    pagesVisited < options.maxPages &&
    !seenPages.has(pageUrl)
  ) {
    seenPages.add(pageUrl);
    const raw = await fetchRawDocument(source.id, pageUrl);
    options.onPage?.(raw);
    const page = discoverWebPlusPage(raw, source);
    for (const item of page.items) items.set(item.url, item);
    pagesVisited += 1;
    pageUrl = page.nextPageUrl;

    if (options.recentLimit !== undefined && items.size >= options.recentLimit) {
      if (reachedRecentLimit) break;
      reachedRecentLimit = true;
    }
  }

  const sourceOrderedItems = [...items.values()];
  return {
    pagesVisited,
    items:
      options.recentLimit === undefined
        ? sourceOrderedItems
        : orderDiscoveredItemsByPublicationRecency(sourceOrderedItems).slice(
            0,
            options.recentLimit,
          ),
  };
}

async function ingestSource(
  source: WebPlusSourceConfig,
  databasePath: string,
  itemLimit: number,
): Promise<IngestSummary> {
  const resolvedDatabasePath = resolve(databasePath);
  const database = new InfoHubDatabase(resolvedDatabasePath);

  try {
    const { pagesVisited, items } = await discoverPages(source, {
      maxPages: 100,
      recentLimit: itemLimit,
      onPage: (rawDocument) =>
        database.persistRawDocument(source, rawDocument),
    });
    let insertedRevisions = 0;
    let unchangedRevisions = 0;

    for (const item of items) {
      const detailRaw = await fetchRawDocument(source.id, item.url);
      const notice = parseWebPlusNotice(detailRaw, source, item);
      const result = database.ingestNotice(source, detailRaw, notice);
      if (result.insertedRevision) insertedRevisions += 1;
      else unchangedRevisions += 1;
    }

    return {
      sourceId: source.id,
      databasePath: resolvedDatabasePath,
      pagesVisited,
      itemsDiscovered: items.length,
      noticesIngested: items.length,
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
  const { items } = await discoverPages(source, {
    maxPages: 100,
    recentLimit: limit,
  });
  const notices = [];
  for (const item of items) {
    const detailRaw = await fetchRawDocument(source.id, item.url);
    notices.push(parseWebPlusNotice(detailRaw, source, item));
  }
  console.log(JSON.stringify(notices, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
