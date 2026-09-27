import { resolve } from "node:path";
import { discoverWebPlusItems, fetchRawDocument, loadSourceDirectory } from "@nju-info/collector";
import type { WebPlusSourceConfig } from "@nju-info/core";
import { collectNotices, discoverPages, ingestSource } from "@nju-info/worker/collection";

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

export async function runSourceCommand(
  args: string[],
  sourceDirectory: string,
  workingDirectory = process.cwd(),
): Promise<void> {
  const [command = "sources", sourceId, thirdArg, fourthArg] = args;
  const sources = await loadSourceDirectory(sourceDirectory);

  if (command === "sources") {
    console.log(JSON.stringify(sources.map(({ id, name, url, adapter }) => ({
      id, name, url, adapter: adapter.type,
    })), null, 2));
    return;
  }

  const sourceCommands = new Set(["discover", "discover-pages", "fetch", "ingest"]);
  if (!sourceCommands.has(command)) throw new Error(`unknown source command: ${command}`);
  if (!sourceId) throw new Error(`usage: source ${command} <source-id> [args...]`);
  const source = findSource(sources, sourceId);

  if (command === "ingest") {
    if (!thirdArg) throw new Error("usage: source ingest <source-id> <database-path> [limit]");
    const result = await ingestSource(
      source,
      resolve(workingDirectory, thirdArg),
      positiveInteger(fourthArg, 10),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "discover-pages") {
    const result = await discoverPages(source, { maxPages: positiveInteger(thirdArg, 2) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "discover") {
    const listRaw = await fetchRawDocument(source.id, source.url);
    const items = discoverWebPlusItems(listRaw, source);
    console.log(JSON.stringify(items.slice(0, positiveInteger(thirdArg, 10)), null, 2));
    return;
  }

  const { notices } = await collectNotices(source, positiveInteger(thirdArg, 1));
  console.log(JSON.stringify(notices, null, 2));
}
