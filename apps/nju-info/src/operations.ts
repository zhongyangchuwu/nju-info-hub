import { InfoHubDatabaseReader } from "@nju-info/db";
import { loadSourceDirectory } from "@nju-info/collector";
import { ingestSource } from "@nju-info/worker/collection";
import { exportFeeds } from "@nju-info/feed";
import type { InstanceConfig } from "@nju-info/instance-config";

export async function collectInstance(
  config: InstanceConfig,
  database: string,
  sourceDirectory: string,
): Promise<void> {
  const registered = new Map(
    (await loadSourceDirectory(sourceDirectory)).map((source) => [source.id, source]),
  );

  for (const selected of config.publication.sources) {
    const source = registered.get(selected.id);
    if (!source) throw new Error(`unknown published source id: ${selected.id}`);
    const summary = await ingestSource(source, database, selected.limit);
    console.log(JSON.stringify(summary, null, 2));
  }
}

export async function exportInstance(
  config: InstanceConfig,
  database: string,
  outputDir: string,
): Promise<void> {
  const sourceIds = config.publication.sources.map((source) => source.id);
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
