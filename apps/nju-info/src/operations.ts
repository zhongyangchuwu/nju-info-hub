import { InfoHubDatabaseReader } from "@nju-info/db";
import { loadSourceDirectory } from "@nju-info/collector";
import { ingestSource } from "@nju-info/worker/collection";
import { exportFeeds } from "@nju-info/feed";
import type { InstanceConfig } from "@nju-info/instance-config";

export interface CollectionSourceFailure {
  sourceId: string;
  message: string;
}

export interface CollectionRunSummary {
  succeededSources: string[];
  failedSources: CollectionSourceFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectInstance(
  config: InstanceConfig,
  database: string,
  sourceDirectory: string,
): Promise<CollectionRunSummary> {
  const registered = new Map(
    (await loadSourceDirectory(sourceDirectory)).map((source) => [source.id, source]),
  );
  const succeededSources: string[] = [];
  const failedSources: CollectionSourceFailure[] = [];
  const failures: unknown[] = [];

  for (const selected of config.collection.sources) {
    const source = registered.get(selected.id);
    if (!source) throw new Error(`unknown collection source id: ${selected.id}`);

    try {
      const summary = await ingestSource(source, database, selected.recentLimit);
      succeededSources.push(selected.id);
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      failures.push(error);
      failedSources.push({
        sourceId: selected.id,
        message: errorMessage(error),
      });
      console.error(
        `[collection] source ${selected.id} failed: ${errorMessage(error)}`,
      );
    }
  }

  if (succeededSources.length === 0 && failures.length > 0) {
    throw new AggregateError(
      failures,
      `all ${failures.length} configured sources failed collection`,
    );
  }

  if (failedSources.length > 0) {
    console.error(
      `[collection] run completed with ${succeededSources.length} succeeded and ${failedSources.length} failed sources`,
    );
  }

  return { succeededSources, failedSources };
}

export async function exportInstance(
  config: InstanceConfig,
  database: string,
  outputDir: string,
): Promise<void> {
  const sourceIds = config.publication.sources;
  const set = config.publication.sets[0];
  const reader = new InfoHubDatabaseReader(database);
  try {
    await exportFeeds(reader, outputDir, sourceIds, {
      publicBaseUrl: config.publication.publicBaseUrl,
      ...(set === undefined ? {} : {
        opmlPath: set.opml,
        sourceSet: {
          id: set.id,
          title: set.title,
          sourceIds: set.sources,
        },
      }),
    });
  } finally {
    reader.close();
  }
}
