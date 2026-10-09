import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Collector from "@nju-info/collector";
import { InfoHubDatabase } from "@nju-info/db";
import type {
  InfoHubDatabase as InfoHubDatabaseType,
} from "@nju-info/db";
import {
  RestrictedDetailError,
  discoverSourcePage,
  fetchRawDocument,
  initialSourcePageUrl,
  parseSourceNotice,
  sourceDetailUrl,
} from "@nju-info/collector";
import type {
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";
import {
  CollectionStageError,
  diagnoseCollectionError,
} from "./diagnostics.js";
import { collectNotices, discoverPages, ingestSource } from "./collection.js";

vi.mock("@nju-info/collector", async () => {
  const actual = await vi.importActual<typeof Collector>("@nju-info/collector");
  return {
    ...actual,
    discoverSourcePage: vi.fn(),
    fetchRawDocument: vi.fn(),
    initialSourcePageUrl: vi.fn(),
    parseSourceNotice: vi.fn(),
    sourceDetailUrl: vi.fn(),
  };
});

vi.mock("@nju-info/db", () => ({ InfoHubDatabase: vi.fn() }));

const LIST_ONE = "https://example.edu/list?page=1";
const LIST_TWO = "https://example.edu/list?page=2";
const SOURCE: SourceConfig = {
  schemaVersion: 1,
  id: "test-source",
  name: "Test source",
  organization: { id: "test-unit", name: "Test unit" },
  url: LIST_ONE,
  adapter: { type: "webplus" },
};

function rawDocument(sourceId: string, url: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-10-01T00:00:00.000Z",
    contentType: "text/html",
    body: "<html></html>",
    sha256: "b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628",
  };
}

function item(
  sourceItemId: string,
  url: string,
  acquisitionKind: DiscoveredItem["acquisitionKind"] = "webplus-detail",
): DiscoveredItem {
  return {
    sourceId: SOURCE.id,
    sourceItemId,
    url,
    acquisitionKind,
    title: `Notice ${sourceItemId}`,
  };
}

function notice(raw: RawDocument, discovered: DiscoveredItem): ParsedNotice {
  return {
    sourceId: SOURCE.id,
    sourceItemId: discovered.sourceItemId,
    url: discovered.url,
    title: discovered.title,
    publishedOn: null,
    bodyText: "Notice body",
    bodyHtml: "<p>Notice body</p>",
    attachments: [],
    provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
  };
}

function makeDatabase() {
  return {
    listKnownSourceItemIds: vi.fn(() => [] as string[]),
    persistRawDocument: vi.fn(),
    close: vi.fn(),
  };
}

let pagesByUrl: Map<string, DiscoveryPage>;
let database = makeDatabase();

beforeEach(() => {
  vi.clearAllMocks();
  pagesByUrl = new Map([[LIST_ONE, { items: [] }]]);
  database = makeDatabase();
  vi.mocked(InfoHubDatabase).mockImplementation(
    function () { return database as unknown as InfoHubDatabaseType; },
  );
  vi.mocked(initialSourcePageUrl).mockReturnValue(LIST_ONE);
  vi.mocked(sourceDetailUrl).mockImplementation((_source, discovered) => discovered.url);
  vi.mocked(fetchRawDocument).mockImplementation(async (sourceId, url) =>
    rawDocument(sourceId, url),
  );
  vi.mocked(discoverSourcePage).mockImplementation(
    (raw) => pagesByUrl.get(raw.url) ?? { items: [] },
  );
  vi.mocked(parseSourceNotice).mockImplementation((raw, _source, discovered) =>
    notice(raw, discovered),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collection stage attribution", () => {
  it("attributes list fetch failures and retains the original cause", async () => {
    const cause = Object.assign(new Error("credential and URL must not escape"), {
      code: "ENOTFOUND",
    });
    vi.mocked(fetchRawDocument).mockRejectedValueOnce(cause);

    const error = await discoverPages(SOURCE, { maxPages: 1 }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(CollectionStageError);
    expect((error as CollectionStageError).phase).toBe("list-fetch");
    expect((error as CollectionStageError).cause).toBe(cause);
    expect(diagnoseCollectionError(error)).toMatchObject({
      phase: "list-fetch",
      causes: [{ name: "CollectionStageError" }, { name: "Error", code: "ENOTFOUND" }],
    });
  });

  it("attributes list parsing and discovery failures separately", async () => {
    const parseCause = new Error("private parser detail");
    vi.mocked(discoverSourcePage).mockImplementationOnce(() => {
      throw parseCause;
    });
    const parseError = await discoverPages(SOURCE, { maxPages: 1 }).catch(
      (failure: unknown) => failure,
    );
    expect(parseError).toBeInstanceOf(CollectionStageError);
    expect((parseError as CollectionStageError).phase).toBe("list-parse");
    expect((parseError as CollectionStageError).cause).toBe(parseCause);

    pagesByUrl.set(LIST_ONE, {
      items: [item("unknown", "https://example.edu/unknown")],
    });
    const discoveryError = await discoverPages(SOURCE, {
      maxPages: 1,
      maxOverlapSearchPages: 1,
      knownSourceItemIds: new Set(["known"]),
    }).catch((failure: unknown) => failure);
    expect(discoveryError).toBeInstanceOf(CollectionStageError);
    expect((discoveryError as CollectionStageError).phase).toBe("discovery");
  });

  it("attributes detail fetch and parse failures without broad skip conversion", async () => {
    const discovered = item("fetch-failure", "https://example.edu/detail/fetch");
    pagesByUrl.set(LIST_ONE, { items: [discovered] });
    const fetchCause = Object.assign(new Error("private request data"), {
      code: "ECONNRESET",
    });
    vi.mocked(fetchRawDocument).mockImplementation(async (sourceId, url) => {
      if (url === LIST_ONE) return rawDocument(sourceId, url);
      throw fetchCause;
    });

    const fetchError = await collectNotices(SOURCE, 10).catch(
      (failure: unknown) => failure,
    );
    expect(fetchError).toBeInstanceOf(CollectionStageError);
    expect((fetchError as CollectionStageError).phase).toBe("detail-fetch");
    expect((fetchError as CollectionStageError).cause).toBe(fetchCause);

    vi.mocked(fetchRawDocument).mockImplementation(async (sourceId, url) =>
      rawDocument(sourceId, url),
    );
    const parseCause = new Error("private detail body");
    vi.mocked(parseSourceNotice).mockImplementationOnce(() => {
      throw parseCause;
    });
    const parseError = await collectNotices(SOURCE, 10).catch(
      (failure: unknown) => failure,
    );
    expect(parseError).toBeInstanceOf(CollectionStageError);
    expect((parseError as CollectionStageError).phase).toBe("detail-parse");
    expect((parseError as CollectionStageError).cause).toBe(parseCause);
  });

  it("attributes database failures to persistence", async () => {
    const cause = Object.assign(new Error("private database path"), {
      code: "SQLITE_BUSY",
    });
    database.persistRawDocument.mockImplementation(() => {
      throw cause;
    });

    const error = await ingestSource(SOURCE, "/tmp/collection.db", 10).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(CollectionStageError);
    expect((error as CollectionStageError).phase).toBe("persistence");
    expect((error as CollectionStageError).cause).toBe(cause);
    expect(database.close).toHaveBeenCalledOnce();
  });
});

describe("collection summary counters", () => {
  it("counts unique new stable IDs without mutating incremental selection state", async () => {
    const firstNew = item("fresh", "https://example.edu/detail/first");
    const duplicateStableId = item("fresh", "https://example.edu/detail/duplicate");
    const known = item("known", "https://example.edu/detail/known");
    const secondNew = item("fresh-two", "https://example.edu/detail/second-new");
    pagesByUrl.set(LIST_ONE, {
      items: [firstNew, duplicateStableId],
      nextPageUrl: LIST_TWO,
    });
    pagesByUrl.set(LIST_TWO, { items: [known, secondNew] });
    const initialKnownIds = new Set(["known"]);

    const result = await collectNotices(
      SOURCE,
      1,
      undefined,
      undefined,
      undefined,
      initialKnownIds,
    );

    expect(result.itemsObserved).toBe(4);
    expect(result.newItemsObserved).toBe(2);
    expect(result.notices.map((entry) => entry.sourceItemId)).toEqual(["fresh", "fresh", "known", "fresh-two"]);
    expect(initialKnownIds).toEqual(new Set(["known"]));
    const detailUrls = vi
      .mocked(fetchRawDocument)
      .mock.calls.map(([, url]) => url)
      .filter((url) => url !== LIST_ONE && url !== LIST_TWO);
    expect(detailUrls).toEqual(
      expect.arrayContaining([
        firstNew.url,
        duplicateStableId.url,
        known.url,
        secondNew.url,
      ]),
    );
  });

  it("counts restricted and unsupported detail skips and emits bounded events", async () => {
    const accepted = item("accepted", "https://example.edu/detail/accepted");
    const restricted = item("restricted", "https://example.edu/detail/restricted");
    const unsupported = item(
      "unsupported",
      "https://example.edu/detail/unsupported",
      "external-public",
    );
    pagesByUrl.set(LIST_ONE, { items: [accepted, restricted, unsupported] });
    vi.mocked(parseSourceNotice).mockImplementation((raw, _source, discovered) => {
      if (discovered.sourceItemId === "restricted") {
        throw new RestrictedDetailError("campus-network");
      }
      return notice(raw, discovered);
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await collectNotices(SOURCE, 10);

    expect(result.notices.map((entry) => entry.sourceItemId)).toEqual(["accepted"]);
    expect(result.skippedRestricted).toBe(1);
    expect(result.skippedUnsupported).toBe(1);
    const events = warning.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(events).toContainEqual({
      event: "restricted_detail_skipped",
      sourceId: SOURCE.id,
      restrictionClass: "campus-network",
    });
    expect(events).toContainEqual({
      event: "unsupported_detail_skipped",
      sourceId: SOURCE.id,
      acquisitionKind: "external-public",
    });
    expect(JSON.stringify(events)).not.toContain("https://example.edu");
  });

});
