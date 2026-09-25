import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverWebPlusItems, fetchRawDocument, loadSourceDirectory } from "@nju-info/collector";
import type { WebPlusSourceConfig } from "@nju-info/core";
import { collectNotices, discoverPages, ingestSource } from "./collection.js";

function sourceDirectory(): string {
  return process.env.NJU_INFO_SOURCE_DIR
    ? resolve(process.env.NJU_INFO_SOURCE_DIR)
    : fileURLToPath(new URL("../../../sources/nju/", import.meta.url));
}

async function loadSources(): Promise<WebPlusSourceConfig[]> {
  return loadSourceDirectory(sourceDirectory());
}

function findSource(sources: WebPlusSourceConfig[], id: string): WebPlusSourceConfig {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error(`unknown source: ${id}`);
  return source;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got: ${value}`);
  }
  return parsed;
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
  const source = findSource(sources, sourceId);

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
