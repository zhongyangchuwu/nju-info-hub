import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfoHubDatabaseReader } from "@nju-info/db";
import type { RawDocument } from "@nju-info/core";
import type { InstanceConfig } from "@nju-info/instance-config";
import type * as Collector from "@nju-info/collector";

const { loadSourceDirectory, fetchRawDocument } = vi.hoisted(() => ({
  loadSourceDirectory: vi.fn(),
  fetchRawDocument: vi.fn(),
}));

vi.mock("@nju-info/collector", async () => ({
  ...await vi.importActual<typeof Collector>("@nju-info/collector"),
  loadSourceDirectory,
  fetchRawDocument,
}));

import { collectInstance } from "./operations.js";

const source = (id: string) => ({
  schemaVersion: 1 as const,
  id,
  name: id,
  organization: { id: "nju-test", name: "Test" },
  url: `https://example.edu/${id}/list.htm`,
  adapter: { type: "webplus" as const },
});

const config: InstanceConfig = {
  schemaVersion: 4,
  instance: { id: "test", name: "Test" },
  publication: { publicBaseUrl: "https://example.invalid/", sources: ["source-a", "source-b", "source-c"], sets: [] },
  collection: {
    schedule: "0 * * * *",
    timeZone: "UTC",
    sources: ["source-a", "source-b", "source-c"].map((id) => ({ id, recentLimit: 10 })),
  },
};

let directory: string;
let database: string;
let failingSources: string[];

function publicDocument(sourceId: string, url: string): RawDocument {
  const body = url.endsWith("/page.htm")
    ? `<h1 class="arti_title">Notice for ${sourceId}</h1><span class="arti_update">2026-10-09</span><div class="wp_articlecontent"><p>Service closes at 18:00.</p></div>`
    : `<ul class="news_list"><li><span class="news_title"><a href="https://example.edu/${sourceId}/page.htm">Notice for ${sourceId}</a></span><span class="news_meta">2026-10-09</span></li></ul>`;
  return { sourceId, url, fetchedAt: new Date().toISOString(), contentType: "text/html", body,
    sha256: createHash("sha256").update(body).digest("hex") };
}

beforeEach(() => {
  vi.restoreAllMocks();
  directory = mkdtempSync(join(tmpdir(), "nju-info-operations-"));
  database = join(directory, "feeds.sqlite");
  failingSources = [];
  loadSourceDirectory.mockResolvedValue([source("source-a"), source("source-b"), source("source-c")]);
  fetchRawDocument.mockImplementation(async (sourceId: string, url: string) => {
    if (failingSources.includes(sourceId)) {
      throw new TypeError("credential=do-not-log", {
        cause: Object.assign(new Error("private token and URL"), { code: "ENOTFOUND" }),
      });
    }
    return publicDocument(sourceId, url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("collectInstance", () => {
  it("retains every feed through a source failure and records no-change recovery without advancing new-item clocks", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await collectInstance(config, database, directory);
    using reader = new InfoHubDatabaseReader(database);
    const initialNotices = reader.listRecentNotices();
    expect(initialNotices.map((notice) => notice.sourceId)).toEqual(["source-a", "source-b", "source-c"]);
    const initial = reader.listCollectionSourceStatuses().find((status) => status.sourceId === "source-b")!;

    failingSources = ["source-b"];
    const partial = await collectInstance(config, database, directory, "scheduled");
    expect(partial.run.outcome).toBe("partial-failure");
    expect(partial.succeededSources).toEqual(["source-a", "source-c"]);
    expect(reader.listRecentNotices()).toEqual(initialNotices);
    const failed = reader.listCollectionSourceStatuses().find((status) => status.sourceId === "source-b")!;
    expect(failed.lastAttempt.outcome).toBe("failure");
    expect(failed.lastAttempt.counts).toBeNull();
    expect(failed.lastAttempt.error).toMatchObject({ phase: "list-fetch", causes: expect.arrayContaining([{ name: "Error", code: "ENOTFOUND" }]) });
    expect(failed.lastSuccessAt).toBe(initial.lastSuccessAt);
    expect(failed.lastNewItemAt).toBe(initial.lastNewItemAt);
    expect(failed.consecutiveFailures).toBe(1);
    expect([...stdout.mock.calls, ...stderr.mock.calls].flat().join("\n")).not.toContain("do-not-log");
    expect([...stdout.mock.calls, ...stderr.mock.calls].flat().join("\n")).not.toContain("private token");

    failingSources = [];
    const recovered = await collectInstance(config, database, directory, "scheduled");
    expect(recovered.run.outcome).toBe("success");
    const status = reader.listCollectionSourceStatuses().find((entry) => entry.sourceId === "source-b")!;
    expect(status.lastAttempt.outcome).toBe("success");
    expect(status.lastAttempt.counts).toMatchObject({ newItemsObserved: 0, insertedRevisions: 0, unchangedRevisions: 1 });
    expect(status.lastSuccessAt).toBe(status.lastAttempt.finishedAt);
    expect(status.lastNewItemAt).toBe(initial.lastNewItemAt);
    expect(status.lastNewRevisionAt).toBe(initial.lastNewRevisionAt);
    expect(status.consecutiveFailures).toBe(0);
  });
  it("completes a malformed aggregate failure and still collects later sources without coercing its metadata", async () => {
    let coerced = false;
    const aggregate = new AggregateError([], "private aggregate message");
    Object.defineProperty(aggregate, "errors", { value: new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return {
          valueOf() { coerced = true; throw new Error("private coercion message"); },
        };
        return Reflect.get(target, property, receiver);
      },
    }) });
    fetchRawDocument.mockImplementation(async (sourceId: string, url: string) => {
      if (sourceId === "source-a") throw aggregate;
      return publicDocument(sourceId, url);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await collectInstance(config, database, directory);
    expect(coerced).toBe(false);
    expect(result.run).toMatchObject({ outcome: "partial-failure", succeededSources: 2, failedSources: 1 });
    using reader = new InfoHubDatabaseReader(database);
    expect(reader.listRecentNotices().map((notice) => notice.sourceId)).toEqual(["source-b", "source-c"]);
    expect(reader.listCollectionSourceStatuses().find((status) => status.sourceId === "source-a")!.lastAttempt)
      .toMatchObject({ outcome: "failure", counts: null, error: { phase: "list-fetch" } });
  });


  it("persists an all-source first-run failure without inventing counts or source success", async () => {
    failingSources = ["source-a", "source-b", "source-c"];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(collectInstance(config, database, directory)).rejects.toBeInstanceOf(AggregateError);
    using reader = new InfoHubDatabaseReader(database);
    expect(reader.listCollectionRuns()[0]).toMatchObject({ outcome: "failure", succeededSources: 0, failedSources: 3 });
    expect(reader.listCollectionSourceStatuses().map((status) => ({
      sourceId: status.sourceId, outcome: status.lastAttempt.outcome,
      counts: status.lastAttempt.counts, lastSuccessAt: status.lastSuccessAt,
    }))).toEqual(["source-a", "source-b", "source-c"].map((sourceId) => ({
      sourceId, outcome: "failure", counts: null, lastSuccessAt: null,
    })));
    expect(reader.listRecentNotices()).toEqual([]);
  });
});
