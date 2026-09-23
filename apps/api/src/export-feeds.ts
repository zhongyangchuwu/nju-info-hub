import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InfoHubDatabaseReader, PersistedSourceSummary } from "@nju-info/db";
import { buildJsonFeed } from "./feed.js";
import { buildOpml } from "./opml.js";
import { feedSelfUrl, publicBaseUrl } from "./syndication.js";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

export type FeedExportReader = Pick<InfoHubDatabaseReader, "listSources" | "listRecentNotices">;

const safeSourceId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSourceId(id: string): void {
  if (!safeSourceId.test(id)) {
    throw new Error(`unsafe source ID cannot be used as a feed filename: ${JSON.stringify(id)}`);
  }
}

export interface FeedExportOptions {
  publicBaseUrl?: string;
  opmlPath?: string;
}

async function safeOpmlPath(outputDirectory: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe OPML path: expected a relative path within the output directory");
  }
  const target = resolve(outputDirectory, path);
  const fromRoot = relative(resolve(outputDirectory), target);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || fromRoot === "feeds" || fromRoot.startsWith(`feeds${sep}`)) {
    throw new Error("unsafe OPML path: expected a relative path outside feeds");
  }
  let current = resolve(outputDirectory);
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("unsafe OPML path: symbolic link");
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
  }
  return target;
}

/** Replace exporter-owned feeds, optionally writing a selected-source OPML catalog. */
export async function exportFeeds(
  reader: FeedExportReader,
  outputDirectory: string,
  sourceIds?: readonly string[],
  options: FeedExportOptions = {},
): Promise<void> {
  const sources = reader.listSources();
  for (const source of sources) validateSourceId(source.id);
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
  const base = options.publicBaseUrl === undefined ? undefined : publicBaseUrl(options.publicBaseUrl);
  if (options.opmlPath !== undefined && !base) throw new Error("OPML export requires a public base URL");
  const opmlTarget = options.opmlPath === undefined ? undefined : await safeOpmlPath(outputDirectory, options.opmlPath);
  const opml = opmlTarget && base ? buildOpml(selectedSources, base) : undefined;
  const generatedAt = new Date().toISOString();

  const feedsDirectory = join(outputDirectory, "feeds");
  await rm(feedsDirectory, { recursive: true, force: true });
  await mkdir(feedsDirectory, { recursive: true });
  for (const source of selectedSources) {
    const notices = reader.listRecentNotices({ sourceId: source.id, limit: 100 });
    const jsonContext = { ...(base ? { selfUrl: feedSelfUrl(base, source.id, "json") } : {}), generatedAt };
    const atomContext = { ...(base ? { selfUrl: feedSelfUrl(base, source.id, "atom") } : {}), generatedAt };
    const feed = buildJsonFeed(source, notices, jsonContext);
    await writeFile(join(feedsDirectory, `${source.id}.json`), `${JSON.stringify(feed, null, 2)}\n`, "utf8");
    await writeFile(join(feedsDirectory, `${source.id}.atom`), buildAtomFeed(source, notices, atomContext), "utf8");
    await writeFile(join(feedsDirectory, `${source.id}.rss`), buildRssFeed(source, notices, { generatedAt }), "utf8");
  }
  if (opmlTarget && opml) {
    await mkdir(dirname(opmlTarget), { recursive: true });
    await writeFile(opmlTarget, opml, "utf8");
  }
}
