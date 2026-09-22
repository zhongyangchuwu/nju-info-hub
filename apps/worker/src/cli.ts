import path from "node:path";
import process from "node:process";
import {
  discoverWebPlusItems,
  discoverWebPlusPage,
  fetchRawDocument,
  loadSourceDirectory,
  parseWebPlusNotice,
} from "@nju-info/collector";
import type { SourceConfig, WebPlusSourceConfig } from "@nju-info/core";

function sourceDirectory(): string {
  return path.resolve(process.cwd(), "../../sources/nju");
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

async function discoverPages(
  source: WebPlusSourceConfig,
  maxPages: number,
): Promise<{
  pagesVisited: number;
  items: ReturnType<typeof discoverWebPlusItems>;
}> {
  const items = new Map<
    string,
    ReturnType<typeof discoverWebPlusItems>[number]
  >();
  const seenPages = new Set<string>();
  let pageUrl: string | undefined = source.url;
  let pagesVisited = 0;

  while (pageUrl && pagesVisited < maxPages && !seenPages.has(pageUrl)) {
    seenPages.add(pageUrl);
    const raw = await fetchRawDocument(source.id, pageUrl);
    const page = discoverWebPlusPage(raw, source);
    for (const item of page.items) items.set(item.url, item);
    pagesVisited += 1;
    pageUrl = page.nextPageUrl;
  }

  return { pagesVisited, items: [...items.values()] };
}

async function main(): Promise<void> {
  const [command = "sources", sourceId, limitArg] = process.argv.slice(2);
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

  if (!sourceId) throw new Error(`usage: ${command} <source-id> [limit]`);
  const source = requireWebPlus(findSource(sources, sourceId));

  if (command === "discover-pages") {
    const result = await discoverPages(source, Number(limitArg ?? 2));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const listRaw = await fetchRawDocument(source.id, source.url);
  const items = discoverWebPlusItems(listRaw, source);

  if (command === "discover") {
    console.log(
      JSON.stringify(items.slice(0, Number(limitArg ?? 10)), null, 2),
    );
    return;
  }

  if (command === "fetch") {
    const limit = Number(limitArg ?? 1);
    const notices = [];
    for (const item of items.slice(0, limit)) {
      const detailRaw = await fetchRawDocument(source.id, item.url);
      notices.push(parseWebPlusNotice(detailRaw, source, item));
    }
    console.log(JSON.stringify(notices, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
