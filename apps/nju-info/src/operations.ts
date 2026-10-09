import { InfoHubDatabase, InfoHubDatabaseReader } from "@nju-info/db";
import { loadSourceDirectory } from "@nju-info/collector";
import { ingestSource } from "@nju-info/worker/collection";
import { exportFeeds } from "@nju-info/feed";
import type { InstanceConfig } from "@nju-info/instance-config";
import type { CollectionErrorDiagnostic, CollectionRun, CollectionSourceCounts, CollectionTrigger } from "@nju-info/core";
import { diagnoseCollectionError } from "@nju-info/worker/diagnostics";

export interface CollectionSourceFailure {
  sourceId: string;
  error: CollectionErrorDiagnostic;
}

export interface CollectionRunSummary {
  run: CollectionRun;
  succeededSources: string[];
  failedSources: CollectionSourceFailure[];
}

export async function collectInstance(
  config: InstanceConfig,
  database: string,
  sourceDirectory: string,
  trigger: CollectionTrigger = "manual",
): Promise<CollectionRunSummary> {
  const registered = new Map(
    (await loadSourceDirectory(sourceDirectory)).map((source) => [source.id, source]),
  );
  const ledger = new InfoHubDatabase(database);
  try {
    const startedAt = new Date().toISOString();
    const runId = ledger.beginCollectionRun(trigger, startedAt);
    console.log(JSON.stringify({ event: "collection.run.started", runId, trigger, startedAt }));
    const succeededSources: string[] = [];
    const failedSources: CollectionSourceFailure[] = [];
    const failures: unknown[] = [];

    for (const selected of config.collection.sources) {
      const source = registered.get(selected.id);
      if (!source) throw new Error(`unknown collection source id: ${selected.id}`);
      const attemptStartedAt = new Date().toISOString();
      const attemptId = ledger.beginCollectionSourceAttempt(runId, selected.id, attemptStartedAt);
      console.log(JSON.stringify({
        event: "collection.source.started", runId, attemptId,
        sourceId: selected.id, startedAt: attemptStartedAt,
      }));

      let counts: CollectionSourceCounts;
      try {
        const summary = await ingestSource(source, database, selected.recentLimit);
        counts = {
          pagesVisited: summary.pagesVisited,
          itemsObserved: summary.itemsObserved,
          newItemsObserved: summary.newItemsObserved,
          noticesIngested: summary.noticesIngested,
          insertedRevisions: summary.insertedRevisions,
          unchangedRevisions: summary.unchangedRevisions,
          skippedRestricted: summary.skippedRestricted,
          skippedUnsupported: summary.skippedUnsupported,
        };
      } catch (error) {
        const diagnostic = diagnoseCollectionError(error);
        const finishedAt = new Date().toISOString();
        console.error(JSON.stringify({
          event: "collection.source.finished", runId, attemptId, sourceId: selected.id,
          finishedAt, outcome: "failure", counts: null, error: diagnostic,
        }));
        ledger.finishCollectionSourceAttempt(attemptId, finishedAt, {
          outcome: "failure", error: diagnostic,
        });
        failures.push(error);
        failedSources.push({ sourceId: selected.id, error: diagnostic });
        continue;
      }

      const finishedAt = new Date().toISOString();
      ledger.finishCollectionSourceAttempt(attemptId, finishedAt, { outcome: "success", counts });
      succeededSources.push(selected.id);
      console.log(JSON.stringify({
        event: "collection.source.finished", runId, attemptId, sourceId: selected.id,
        finishedAt, outcome: "success", counts, error: null,
      }));
    }

    const run = ledger.finishCollectionRun(runId, new Date().toISOString());
    const log = JSON.stringify({ event: "collection.run.finished", ...run });
    if (run.outcome === "success") console.log(log);
    else console.error(log);
    if (succeededSources.length === 0 && failures.length > 0) {
      throw new AggregateError(failures, `all ${failures.length} configured sources failed collection`);
    }
    return { run, succeededSources, failedSources };
  } finally {
    ledger.close();
  }
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
