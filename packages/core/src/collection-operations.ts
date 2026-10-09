export type CollectionTrigger = "manual" | "startup" | "scheduled";

export type CollectionPhase =
  | "list-fetch"
  | "list-parse"
  | "discovery"
  | "detail-fetch"
  | "detail-parse"
  | "persistence"
  | "collection";

/** Public-safe diagnostics exclude exception messages, stacks, URLs and response bodies. */
export interface CollectionErrorDiagnostic {
  phase: CollectionPhase;
  causes: Array<{
    name: string;
    code?: string;
    status?: number;
  }>;
}

export interface CollectionSourceCounts {
  pagesVisited: number;
  itemsObserved: number;
  newItemsObserved: number;
  noticesIngested: number;
  insertedRevisions: number;
  unchangedRevisions: number;
  skippedRestricted: number;
  skippedUnsupported: number;
}

export interface CollectionRun {
  id: number;
  trigger: CollectionTrigger;
  startedAt: string;
  finishedAt: string | null;
  outcome: "unfinished" | "success" | "partial-failure" | "failure";
  succeededSources: number;
  failedSources: number;
}

export interface CollectionSourceAttempt {
  id: number;
  runId: number;
  sourceId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "unfinished" | "success" | "failure";
  counts: CollectionSourceCounts | null;
  error: CollectionErrorDiagnostic | null;
}

export type CollectionSourceCompletion =
  | { outcome: "success"; counts: CollectionSourceCounts }
  | { outcome: "failure"; error: CollectionErrorDiagnostic };

export interface CollectionSourceStatus {
  sourceId: string;
  lastAttempt: CollectionSourceAttempt;
  lastSuccessAt: string | null;
  lastNewItemAt: string | null;
  lastNewRevisionAt: string | null;
  consecutiveFailures: number;
}
