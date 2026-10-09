import { resolve } from "node:path";
import {
  discoverSourcePage,
  fetchRawDocument,
  initialSourcePageUrl,
  loadSourceDirectory,
} from "@nju-info/collector";
import type { SourceConfig } from "@nju-info/core";
import { collectNotices, discoverPages, ingestSource } from "@nju-info/worker/collection";
import { RuntimeInputError } from "./runtime-input.js";

const sourceCommands: Record<string, true> = {
  discover: true, "discover-pages": true, fetch: true, ingest: true,
};

function findSource(sources: SourceConfig[], id: string): SourceConfig {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new RuntimeInputError("unknown_source");
  return source;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeInputError("invalid_limit");
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

  if (sourceCommands[command] !== true) throw new RuntimeInputError("unknown_source_command");
  if (!sourceId) throw new RuntimeInputError("usage_source");
  const source = findSource(sources, sourceId);

  if (command === "ingest") {
    if (!thirdArg) throw new RuntimeInputError("usage_source_ingest");
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
    const listRaw = await fetchRawDocument(source.id, initialSourcePageUrl(source));
    const page = discoverSourcePage(listRaw, source);
    console.log(JSON.stringify(page.items.slice(0, positiveInteger(thirdArg, 10)), null, 2));
    return;
  }

  const { notices } = await collectNotices(source, positiveInteger(thirdArg, 1));
  console.log(JSON.stringify(notices, null, 2));
}
