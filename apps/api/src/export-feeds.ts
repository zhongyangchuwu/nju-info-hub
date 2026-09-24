import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InfoHubDatabaseReader, PersistedSourceSummary } from "@nju-info/db";
import { buildAtomBundle, buildJsonBundle, buildRssBundle, type BundlePart } from "./bundle.js";
import { buildJsonFeed } from "./feed.js";
import { buildOpml } from "./opml.js";
import { buildSetCatalog, buildSourceCatalog, bundleSelfUrl, resolveSourceSet, subscriptionSelfUrl, type SourceSetDefinition } from "./source-set.js";
import { feedSelfUrl, publicBaseUrl } from "./syndication.js";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

export type FeedExportReader = Pick<InfoHubDatabaseReader, "listSources" | "listRecentNotices">;

const safeSourceId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSourceId(id: string): void {
  if (!safeSourceId.test(id)) {
    throw new Error("unsafe source ID cannot be used as a feed filename: " + JSON.stringify(id));
  }
}

export interface FeedExportOptions {
  publicBaseUrl?: string;
  opmlPath?: string;
  sourceSet?: SourceSetDefinition;
}

async function safeOpmlPath(outputDirectory: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe OPML path: expected a relative path within the output directory");
  }
  const target = resolve(outputDirectory, path);
  const fromRoot = relative(resolve(outputDirectory), target);
  const exporterDirectories = ["feeds", "catalog", "bundles"];
  if (exporterDirectories.some((directory) => fromRoot === directory || fromRoot.startsWith(directory + sep))) {
    throw new Error("unsafe OPML path: expected a relative path outside exporter-owned directories");
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

async function validateCatalogDirectory(outputDirectory: string): Promise<void> {
  try {
    const stats = await lstat(join(outputDirectory, "catalog"));
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("unsafe catalog path: expected a directory, not a symbolic link or file");
    }
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
  }
}

/** Replace exporter-owned per-source feeds and optionally publish a catalog, OPML, and one combined source set. */
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
      throw new Error("unknown source ID" + (unknownIds.length === 1 ? "" : "s") + ": " + unknownIds.join(", "));
    }
    const requestedIds = new Set(sourceIds);
    selectedSources = sources.filter((source) => requestedIds.has(source.id));
  }

  const base = options.publicBaseUrl === undefined ? undefined : publicBaseUrl(options.publicBaseUrl);
  if (options.opmlPath !== undefined && !base) throw new Error("OPML export requires a public base URL");
  if (options.sourceSet !== undefined && !base) throw new Error("source set export requires a public base URL");

  const sourceSet = options.sourceSet === undefined ? undefined : resolveSourceSet(options.sourceSet, selectedSources);
  const opmlPath = options.opmlPath ?? (sourceSet ? `subscriptions/${sourceSet.id}.opml` : undefined);
  const opmlTarget = opmlPath === undefined ? undefined : await safeOpmlPath(outputDirectory, opmlPath);
  const sourceCatalog = base ? buildSourceCatalog(selectedSources, base) : undefined;
  const setCatalog = sourceSet && base && opmlPath ? buildSetCatalog(sourceSet, base, opmlPath) : undefined;
  await validateCatalogDirectory(outputDirectory);
  const opml = opmlTarget && base ? buildOpml(sourceSet?.sources ?? selectedSources, base) : undefined;
  const generatedAt = new Date().toISOString();

  const noticesBySource = new Map<string, ReturnType<FeedExportReader["listRecentNotices"]>>();
  for (const source of selectedSources) {
    noticesBySource.set(source.id, reader.listRecentNotices({ sourceId: source.id, limit: 100 }));
  }

  const feedsDirectory = join(outputDirectory, "feeds");
  await rm(feedsDirectory, { recursive: true, force: true });
  await mkdir(feedsDirectory, { recursive: true });
  for (const source of selectedSources) {
    const notices = noticesBySource.get(source.id) ?? [];
    const jsonContext = { ...(base ? { selfUrl: feedSelfUrl(base, source.id, "json") } : {}), generatedAt };
    const atomContext = { ...(base ? { selfUrl: feedSelfUrl(base, source.id, "atom") } : {}), generatedAt };
    const feed = buildJsonFeed(source, notices, jsonContext);
    await writeFile(join(feedsDirectory, source.id + ".json"), JSON.stringify(feed, null, 2) + "\n", "utf8");
    await writeFile(join(feedsDirectory, source.id + ".atom"), buildAtomFeed(source, notices, atomContext), "utf8");
    await writeFile(join(feedsDirectory, source.id + ".rss"), buildRssFeed(source, notices, { generatedAt }), "utf8");
  }

  const catalogDirectory = join(outputDirectory, "catalog");
  await rm(catalogDirectory, { recursive: true, force: true });
  if (base && sourceCatalog) {
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(join(catalogDirectory, "sources.json"), JSON.stringify(sourceCatalog, null, 2) + "\n", "utf8");
    if (setCatalog) {
      await writeFile(join(catalogDirectory, "sets.json"), JSON.stringify(setCatalog, null, 2) + "\n", "utf8");
    }
  }

  if (sourceSet && base) {
    const parts: BundlePart[] = sourceSet.sources.map((source) => ({
      source,
      notices: noticesBySource.get(source.id) ?? [],
    }));
    const bundlesDirectory = join(outputDirectory, "bundles");
    await mkdir(bundlesDirectory, { recursive: true });
    await writeFile(
      join(bundlesDirectory, sourceSet.id + ".json"),
      JSON.stringify(buildJsonBundle(sourceSet, parts, {
        selfUrl: bundleSelfUrl(base, sourceSet.id, "json"),
        generatedAt,
      }), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      join(bundlesDirectory, sourceSet.id + ".atom"),
      buildAtomBundle(sourceSet, parts, {
        selfUrl: bundleSelfUrl(base, sourceSet.id, "atom"),
        generatedAt,
      }),
      "utf8",
    );
    await writeFile(
      join(bundlesDirectory, sourceSet.id + ".rss"),
      buildRssBundle(sourceSet, parts, {
        selfUrl: bundleSelfUrl(base, sourceSet.id, "rss"),
        generatedAt,
      }),
      "utf8",
    );
  }

  if (opmlTarget && opml) {
    await mkdir(dirname(opmlTarget), { recursive: true });
    await writeFile(opmlTarget, opml, "utf8");
  }

}
