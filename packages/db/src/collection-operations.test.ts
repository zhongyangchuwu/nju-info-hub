import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectionSourceCounts, WebPlusSourceConfig } from "@nju-info/core";
import { InfoHubDatabase, InfoHubDatabaseReader } from "./database.js";

const COUNTS: CollectionSourceCounts = {
  pagesVisited: 1, itemsObserved: 1, newItemsObserved: 1, noticesIngested: 1,
  insertedRevisions: 1, unchangedRevisions: 0, skippedRestricted: 0, skippedUnsupported: 0,
};
const NO_CHANGE: CollectionSourceCounts = {
  ...COUNTS, newItemsObserved: 0, insertedRevisions: 0, unchangedRevisions: 1,
};
const FAILURE = { outcome: "failure" as const,
  error: { phase: "list-fetch" as const, causes: [{ name: "TypeError", code: "ETIMEDOUT" }] } };
const SOURCE: WebPlusSourceConfig = {
  schemaVersion: 1, id: "website", name: "Website",
  organization: { id: "organization", name: "Organization" },
  url: "https://example.edu/list.htm", adapter: { type: "webplus" },
};
const T1 = "2026-10-09T10:00:00.000Z";
const T2 = "2026-10-09T11:00:00.000Z";
const T3 = "2026-10-09T12:00:00.000Z";
let directory: string;
let path: string;
let database: InfoHubDatabase;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nju-collection-db-"));
  path = join(directory, "test.sqlite");
  database = new InfoHubDatabase(path);
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("persisted collection operations", () => {
  it("records a first-ever fetch failure without registering a canonical source and retains it after restart", () => {
    const runId = database.beginCollectionRun("manual", T1);
    const attemptId = database.beginCollectionSourceAttempt(runId, "unregistered", T1);
    database.finishCollectionSourceAttempt(attemptId, T2, FAILURE);
    expect(() => database.finishCollectionSourceAttempt(attemptId, T3, { outcome: "success", counts: COUNTS }))
      .toThrow(/already completed/);
    const finished = database.finishCollectionRun(runId, T3);
    expect(finished).toEqual({ id: runId, trigger: "manual", startedAt: T1, finishedAt: T3,
      outcome: "failure", succeededSources: 0, failedSources: 1 });
    database.close();
    database = new InfoHubDatabase(path);
    using reader = new InfoHubDatabaseReader(path);
    const attempt = { id: attemptId, runId, sourceId: "unregistered", startedAt: T1,
      finishedAt: T2, outcome: "failure", counts: null, error: FAILURE.error };
    expect(reader.listCollectionRuns()).toEqual([finished]);
    expect(reader.listCollectionSourceAttempts(runId)).toEqual([attempt]);
    expect(reader.listCollectionSourceStatuses()).toEqual([{ sourceId: "unregistered", lastAttempt: attempt,
      lastSuccessAt: null, lastNewItemAt: null, lastNewRevisionAt: null, consecutiveFailures: 1 }]);
    expect(reader.stats()).toEqual({ sources: 0, rawDocuments: 0, sourceItems: 0,
      sourceItemObservations: 0, noticeRevisions: 0, attachments: 0 });
    expect("beginCollectionRun" in reader).toBe(false);
    expect("finishCollectionSourceAttempt" in reader).toBe(false);
    const nextRun = database.beginCollectionRun("startup", T3);
    const nextAttempt = database.beginCollectionSourceAttempt(nextRun, "unregistered", T3);
    expect(nextRun).toBeGreaterThan(runId);
    expect(nextAttempt).toBeGreaterThan(attemptId);
  });

  it("retains success clocks through failures and resets consecutive failures on no-change recovery", () => {
    database.upsertSource(SOURCE);
    database.upsertSource({ ...SOURCE, id: "never-attempted" });
    const runId = database.beginCollectionRun("scheduled", T1);
    const success = database.beginCollectionSourceAttempt(runId, SOURCE.id, T1);
    database.finishCollectionSourceAttempt(success, T1, { outcome: "success", counts: COUNTS });
    database.finishCollectionRun(runId, T1);
    for (let index = 0; index < 2; index++) {
      const failedRun = database.beginCollectionRun("scheduled", T2);
      const failure = database.beginCollectionSourceAttempt(failedRun, SOURCE.id, T2);
      database.finishCollectionSourceAttempt(failure, T2, FAILURE);
      expect(database.finishCollectionRun(failedRun, T2)).toMatchObject({
        outcome: "failure", succeededSources: 0, failedSources: 1,
      });
    }
    expect(database.listCollectionSourceStatuses()).toMatchObject([{ sourceId: SOURCE.id,
      lastAttempt: { outcome: "failure", counts: null }, lastSuccessAt: T1, lastNewItemAt: T1,
      lastNewRevisionAt: T1, consecutiveFailures: 2 }]);
    const recoveryRun = database.beginCollectionRun("scheduled", T3);
    const recovery = database.beginCollectionSourceAttempt(recoveryRun, SOURCE.id, T3);
    database.finishCollectionSourceAttempt(recovery, T3, { outcome: "success", counts: NO_CHANGE });
    expect(database.listCollectionSourceStatuses()).toMatchObject([{ sourceId: SOURCE.id,
      lastAttempt: { id: recovery, outcome: "success", counts: NO_CHANGE }, lastSuccessAt: T3,
      lastNewItemAt: T1, lastNewRevisionAt: T1, consecutiveFailures: 0 }]);
    const otherFailure = database.beginCollectionSourceAttempt(recoveryRun, "another-source", T3);
    database.finishCollectionSourceAttempt(otherFailure, T3, FAILURE);
    expect(database.finishCollectionRun(recoveryRun, T3)).toMatchObject({ outcome: "partial-failure",
      succeededSources: 1, failedSources: 1 });
  });

  it("advances new-item and new-revision clocks independently using attempt ids rather than run ids or time", () => {
    const oldRun = database.beginCollectionRun("startup", T3);
    const newerRun = database.beginCollectionRun("manual", T2);
    const first = database.beginCollectionSourceAttempt(newerRun, SOURCE.id, T3);
    database.finishCollectionSourceAttempt(first, T3, { outcome: "success", counts: COUNTS });
    const revision = database.beginCollectionSourceAttempt(oldRun, SOURCE.id, T2);
    database.finishCollectionSourceAttempt(revision, T2,
      { outcome: "success", counts: { ...NO_CHANGE, insertedRevisions: 1, unchangedRevisions: 0 } });
    expect(revision).toBeGreaterThan(first);
    expect(database.listCollectionSourceStatuses()).toMatchObject([{ lastAttempt: { id: revision, runId: oldRun },
      lastSuccessAt: T2, lastNewItemAt: T3, lastNewRevisionAt: T2, consecutiveFailures: 0 }]);
    const newItemRun = database.beginCollectionRun("scheduled", T1);
    const newItem = database.beginCollectionSourceAttempt(newItemRun, SOURCE.id, T1);
    database.finishCollectionSourceAttempt(newItem, T1,
      { outcome: "success", counts: { ...NO_CHANGE, newItemsObserved: 1, noticesIngested: 0 } });
    expect(database.listCollectionSourceStatuses()).toMatchObject([{ lastAttempt: { id: newItem },
      lastSuccessAt: T1, lastNewItemAt: T1, lastNewRevisionAt: T2 }]);
    expect(database.listCollectionSourceAttempts(oldRun).map((attempt) => attempt.id)).toEqual([revision]);
    expect(database.finishCollectionRun(oldRun, T1).outcome).toBe("success");
    database.finishCollectionRun(newerRun, T1);
    database.finishCollectionRun(newItemRun, T1);
    expect(database.listCollectionRuns().map((run) => run.id)).toEqual([newItemRun, newerRun, oldRun]);
  });

  it("preserves unfinished crash state without inventing recovery and refuses to finish its parent", () => {
    const failedRunId = database.beginCollectionRun("startup", T1);
    const failure = database.beginCollectionSourceAttempt(failedRunId, SOURCE.id, T1);
    database.finishCollectionSourceAttempt(failure, T2, FAILURE);
    database.finishCollectionRun(failedRunId, T2);
    const runId = database.beginCollectionRun("scheduled", T3);
    const pending = database.beginCollectionSourceAttempt(runId, SOURCE.id, T3);
    expect(() => database.finishCollectionRun(runId, T3)).toThrow(/unfinished/);
    database.close();
    database = new InfoHubDatabase(path);
    using reader = new InfoHubDatabaseReader(path);
    expect(reader.listCollectionRuns()).toEqual([
      { id: runId, trigger: "scheduled", startedAt: T3, finishedAt: null,
        outcome: "unfinished", succeededSources: 0, failedSources: 0 },
      { id: failedRunId, trigger: "startup", startedAt: T1, finishedAt: T2,
        outcome: "failure", succeededSources: 0, failedSources: 1 },
    ]);
    expect(reader.listCollectionSourceStatuses()).toEqual([{ sourceId: SOURCE.id,
      lastAttempt: { id: pending, runId, sourceId: SOURCE.id, startedAt: T3, finishedAt: null,
        outcome: "unfinished", counts: null, error: null },
      lastSuccessAt: null, lastNewItemAt: null, lastNewRevisionAt: null, consecutiveFailures: 1 }]);
    expect(() => database.finishCollectionRun(runId, T3)).toThrow(/unfinished/);
  });

  it("does not let an incomplete attempt advance existing success clocks", () => {
    const runId = database.beginCollectionRun("manual", T1);
    const success = database.beginCollectionSourceAttempt(runId, SOURCE.id, T1);
    database.finishCollectionSourceAttempt(success, T1, { outcome: "success", counts: COUNTS });
    database.finishCollectionRun(runId, T1);
    const failedRun = database.beginCollectionRun("scheduled", T2);
    const failure = database.beginCollectionSourceAttempt(failedRun, SOURCE.id, T2);
    database.finishCollectionSourceAttempt(failure, T2, FAILURE);
    database.finishCollectionRun(failedRun, T2);
    const pendingRun = database.beginCollectionRun("scheduled", T3);
    const incomplete = database.beginCollectionSourceAttempt(pendingRun, SOURCE.id, T3);
    expect(database.listCollectionSourceStatuses()).toMatchObject([{ lastAttempt: { id: incomplete, outcome: "unfinished" },
      lastSuccessAt: T1, lastNewItemAt: T1, lastNewRevisionAt: T1, consecutiveFailures: 1 }]);
  });

  it("rejects duplicate source attempts within a run without inflating its source totals", () => {
    const runId = database.beginCollectionRun("manual", T1);
    const attemptId = database.beginCollectionSourceAttempt(runId, SOURCE.id, T1);
    expect(() => database.beginCollectionSourceAttempt(runId, SOURCE.id, T2)).toThrow(/UNIQUE/);
    expect(database.listCollectionSourceAttempts(runId)).toEqual([{ id: attemptId, runId, sourceId: SOURCE.id,
      startedAt: T1, finishedAt: null, outcome: "unfinished", counts: null, error: null }]);
    database.finishCollectionSourceAttempt(attemptId, T2, { outcome: "success", counts: COUNTS });
    expect(() => database.beginCollectionSourceAttempt(runId, SOURCE.id, T3)).toThrow(/UNIQUE/);
    expect(database.finishCollectionRun(runId, T3)).toMatchObject({
      outcome: "success", succeededSources: 1, failedSources: 0,
    });
    const retryRun = database.beginCollectionRun("manual", T3);
    const retryAttempt = database.beginCollectionSourceAttempt(retryRun, SOURCE.id, T3);
    expect(retryAttempt).toBeGreaterThan(attemptId);
    expect(database.listCollectionSourceAttempts(retryRun)).toMatchObject([{ id: retryAttempt, outcome: "unfinished" }]);
  });

  it("rejects duplicate completions and attempts on completed or missing runs without changing finished data", () => {
    const runId = database.beginCollectionRun("manual", T1);
    const attemptId = database.beginCollectionSourceAttempt(runId, SOURCE.id, T1);
    database.finishCollectionSourceAttempt(attemptId, T2, { outcome: "success", counts: COUNTS });
    expect(() => database.finishCollectionSourceAttempt(attemptId, T3, FAILURE)).toThrow(/already completed/);
    const finished = database.finishCollectionRun(runId, T2);
    expect(() => database.finishCollectionRun(runId, T3)).toThrow(/already completed/);
    expect(() => database.beginCollectionSourceAttempt(runId, SOURCE.id, T3)).toThrow(/already completed/);
    expect(() => database.beginCollectionSourceAttempt(9999, SOURCE.id, T3)).toThrow(/missing/);
    expect(() => database.finishCollectionSourceAttempt(9999, T3, FAILURE)).toThrow(/missing/);
    expect(() => database.finishCollectionRun(9999, T3)).toThrow(/missing/);
    expect(database.listCollectionRuns()).toEqual([finished]);
    expect(database.listCollectionSourceAttempts(runId)).toEqual([{ id: attemptId, runId, sourceId: SOURCE.id,
      startedAt: T1, finishedAt: T2, outcome: "success", counts: COUNTS, error: null }]);
  });

  it("keeps failed counts null despite partial canonical writes and stores only structured diagnostic fields", () => {
    const runId = database.beginCollectionRun("manual", T1);
    const attemptId = database.beginCollectionSourceAttempt(runId, SOURCE.id, T1);
    const body = "Partial listing";
    database.persistRawDocument(SOURCE, { sourceId: SOURCE.id, url: SOURCE.url, fetchedAt: T1,
      contentType: "text/html", body, sha256: createHash("sha256").update(body).digest("hex") });
    const diagnostic = { ...FAILURE.error, message: "SECRET https://private.invalid", stack: "SECRET stack",
      body: "SECRET body", causes: [{ ...FAILURE.error.causes[0]!, status: 503, message: "SECRET cause", url: "SECRET url" }] };
    database.finishCollectionSourceAttempt(attemptId, T2, { outcome: "failure", error: diagnostic });
    expect(database.stats().rawDocuments).toBe(1);
    expect(database.listCollectionSourceAttempts(runId)).toMatchObject([{ counts: null,
      error: { phase: "list-fetch", causes: [{ name: "TypeError", code: "ETIMEDOUT", status: 503 }] } }]);
    using inspection = new DatabaseSync(path, { readOnly: true });
    const row = inspection.prepare("SELECT counts_json, error_json FROM collection_source_attempts").get()!;
    expect(row.counts_json).toBeNull();
    expect(JSON.parse(String(row.error_json))).toEqual({ phase: "list-fetch",
      causes: [{ name: "TypeError", code: "ETIMEDOUT", status: 503 }] });
    expect(row.error_json).not.toContain("SECRET");
    expect(database.finishCollectionRun(runId, T3).outcome).toBe("failure");
  });

  it("bounds run history to 20 by default and accepts only integer limits from 1 to 100", () => {
    for (let index = 0; index < 25; index++) database.beginCollectionRun("scheduled", T1);
    using reader = new InfoHubDatabaseReader(path);
    expect(reader.listCollectionRuns()).toHaveLength(20);
    expect(reader.listCollectionRuns(1)[0]?.id).toBe(25);
    expect(reader.listCollectionRuns(100)).toHaveLength(25);
    expect(reader.listCollectionSourceAttempts(9999)).toEqual([]);
    expect(reader.listCollectionSourceStatuses()).toEqual([]);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      expect(() => reader.listCollectionRuns(limit)).toThrow(/integer from 1 to 100/);
      expect(() => database.listCollectionRuns(limit)).toThrow(/integer from 1 to 100/);
    }
  });
});
