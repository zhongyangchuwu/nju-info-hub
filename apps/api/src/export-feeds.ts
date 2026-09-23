import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InfoHubDatabaseReader, PersistedSourceSummary } from "@nju-info/db";
import { buildJsonFeed } from "./feed.js";

export type FeedExportReader = Pick<InfoHubDatabaseReader, "listSources" | "listRecentNotices">;

const safeSourceId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSourceId(id: string): void {
  if (!safeSourceId.test(id)) {
    throw new Error(`unsafe source ID cannot be used as a feed filename: ${JSON.stringify(id)}`);
  }
}

/** Write JSON Feed documents for every source, or only the explicitly requested source IDs. */
export async function exportFeeds(
  reader: FeedExportReader,
  outputDirectory: string,
  sourceIds?: readonly string[],
): Promise<void> {
  const sources = reader.listSources();
  let selectedSources: PersistedSourceSummary[];

  if (sourceIds === undefined) {
    selectedSources = sources;
  } else {
    for (const id of sourceIds) validateSourceId(id);
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const unknownIds = sourceIds.filter((id) => !sourcesById.has(id));
    if (unknownIds.length) {
      throw new Error(`unknown source ID${unknownIds.length === 1 ? "" : "s"}: ${unknownIds.join(", ")}`);
    }
    const requestedIds = new Set(sourceIds);
    selectedSources = sources.filter((source) => requestedIds.has(source.id));
  }

  for (const source of selectedSources) validateSourceId(source.id);
  const feedsDirectory = join(outputDirectory, "feeds");
  await mkdir(feedsDirectory, { recursive: true });
  for (const source of selectedSources) {
    const feed = buildJsonFeed(source, reader.listRecentNotices({ sourceId: source.id, limit: 100 }));
    await writeFile(join(feedsDirectory, `${source.id}.json`), `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  }
}
