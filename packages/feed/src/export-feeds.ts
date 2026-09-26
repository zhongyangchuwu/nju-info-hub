import type {
  InfoHubDatabaseReader,
  PersistedSourceSummary,
  SourceEntryQueryResult,
} from "@nju-info/db";
import {
  buildAtomBundle,
  buildJsonBundle,
  buildRssBundle,
  type BundlePart,
} from "./bundle.js";
import { buildJsonFeed } from "./feed.js";
import { buildOpml } from "./opml.js";
import { publishFiles, type PublicationFile } from "./publication-transaction.js";
import { feedRecentItemLimit } from "./policy.js";
import {
  buildSetCatalog,
  buildSourceCatalog,
  bundleSelfUrl,
  resolveSourceSet,
  validateSubscriptionPath,
  type SourceSetDefinition,
} from "./source-set.js";
import { feedSelfUrl, publicBaseUrl } from "./syndication.js";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

export type FeedExportReader = Pick<
  InfoHubDatabaseReader,
  "listSources" | "listRecentSourceEntries"
>;

const safeSourceId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSourceId(id: string): void {
  if (!safeSourceId.test(id)) {
    throw new Error(
      "unsafe source ID cannot be used as a feed filename: " + JSON.stringify(id),
    );
  }
}

export interface FeedExportOptions {
  publicBaseUrl?: string;
  opmlPath?: string;
  sourceSet?: SourceSetDefinition;
}

function renderSourceFiles(
  source: PersistedSourceSummary,
  sourceEntries: SourceEntryQueryResult[],
  base: URL | undefined,
  generatedAt: string,
): PublicationFile[] {
  const jsonContext = {
    ...(base ? { selfUrl: feedSelfUrl(base, source.id, "json") } : {}),
    generatedAt,
  };
  const atomContext = {
    ...(base ? { selfUrl: feedSelfUrl(base, source.id, "atom") } : {}),
    generatedAt,
  };
  return [
    {
      path: `feeds/${source.id}.json`,
      content: JSON.stringify(
        buildJsonFeed(source, sourceEntries, jsonContext),
        null,
        2,
      ) + "\n",
    },
    {
      path: `feeds/${source.id}.atom`,
      content: buildAtomFeed(source, sourceEntries, atomContext),
    },
    {
      path: `feeds/${source.id}.rss`,
      content: buildRssFeed(source, sourceEntries, { generatedAt }),
    },
  ];
}

/** Render one complete feed publication, then transactionally replace the owned output directories. */
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
      throw new Error(
        "unknown source ID" +
        (unknownIds.length === 1 ? "" : "s") +
        ": " +
        unknownIds.join(", "),
      );
    }
    const requestedIds = new Set(sourceIds);
    selectedSources = sources.filter((source) => requestedIds.has(source.id));
  }

  const base = options.publicBaseUrl === undefined
    ? undefined
    : publicBaseUrl(options.publicBaseUrl);
  if (options.opmlPath !== undefined && !base) {
    throw new Error("OPML export requires a public base URL");
  }
  if (options.sourceSet !== undefined && !base) {
    throw new Error("source set export requires a public base URL");
  }

  const sourceSet = options.sourceSet === undefined
    ? undefined
    : resolveSourceSet(options.sourceSet, selectedSources);
  const opmlPath = options.opmlPath ??
    (sourceSet ? `subscriptions/${sourceSet.id}.opml` : undefined);
  if (opmlPath !== undefined) validateSubscriptionPath(opmlPath);

  const sourceCatalog = base
    ? buildSourceCatalog(selectedSources, base)
    : undefined;
  const setCatalog = sourceSet && base && opmlPath
    ? buildSetCatalog(sourceSet, base, opmlPath)
    : undefined;
  const opml = opmlPath && base
    ? buildOpml(sourceSet?.sources ?? selectedSources, base)
    : undefined;
  const generatedAt = new Date().toISOString();

  const sourceEntriesBySource = new Map<string, SourceEntryQueryResult[]>();
  for (const source of selectedSources) {
    sourceEntriesBySource.set(
      source.id,
      reader.listRecentSourceEntries({
        sourceId: source.id,
        limit: feedRecentItemLimit,
      }),
    );
  }

  const files: PublicationFile[] = selectedSources.flatMap((source) =>
    renderSourceFiles(
      source,
      sourceEntriesBySource.get(source.id) ?? [],
      base,
      generatedAt,
    )
  );

  if (sourceCatalog) {
    files.push({
      path: "catalog/sources.json",
      content: JSON.stringify(sourceCatalog, null, 2) + "\n",
    });
  }
  if (setCatalog) {
    files.push({
      path: "catalog/sets.json",
      content: JSON.stringify(setCatalog, null, 2) + "\n",
    });
  }

  if (sourceSet && base) {
    const parts: BundlePart[] = sourceSet.sources.map((source) => ({
      source,
      entries: sourceEntriesBySource.get(source.id) ?? [],
    }));
    files.push(
      {
        path: `bundles/${sourceSet.id}.json`,
        content: JSON.stringify(
          buildJsonBundle(sourceSet, parts, {
            selfUrl: bundleSelfUrl(base, sourceSet.id, "json"),
            generatedAt,
          }),
          null,
          2,
        ) + "\n",
      },
      {
        path: `bundles/${sourceSet.id}.atom`,
        content: buildAtomBundle(sourceSet, parts, {
          selfUrl: bundleSelfUrl(base, sourceSet.id, "atom"),
          generatedAt,
        }),
      },
      {
        path: `bundles/${sourceSet.id}.rss`,
        content: buildRssBundle(sourceSet, parts, {
          selfUrl: bundleSelfUrl(base, sourceSet.id, "rss"),
          generatedAt,
        }),
      },
    );
  }

  if (opmlPath && opml) {
    files.push({ path: opmlPath, content: opml });
  }

  await publishFiles(outputDirectory, files);
}
