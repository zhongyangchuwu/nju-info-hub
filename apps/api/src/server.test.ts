import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoHubDatabase, InfoHubDatabaseReader } from "@nju-info/db";
import { parseArgs } from "./config.js";
import { createApiServer, startApi, type ApiService } from "./server.js";

type Source = Parameters<InfoHubDatabase["upsertSource"]>[0];
const source: Source = {
  schemaVersion: 1,
  id: "notices-a",
  name: "First source",
  organization: { id: "group-a", name: "First organization" },
  url: "https://example.edu/a/list.htm",
  audience: ["students"],
  categories: ["notices"],
  enabled: true,
  adapter: { type: "webplus" },
};
const sibling: Source = {
  ...source,
  id: "notices-b",
  name: "Second source",
  organization: { id: "group-b", name: "Second organization" },
  enabled: false,
};

const services: ApiService[] = [];
const directories: string[] = [];
const writers: InfoHubDatabase[] = [];
const extraServers: Server[] = [];
const readers: InfoHubDatabaseReader[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const server of extraServers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
  }
  for (const reader of readers.splice(0)) reader.close();
  for (const writer of writers.splice(0)) writer.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function database(): { path: string; writer: InfoHubDatabase } {
  const directory = mkdtempSync(join(tmpdir(), "nju-info-api-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const writer = new InfoHubDatabase(path);
  writers.push(writer);
  return { path, writer };
}

function notice(writer: InfoHubDatabase, origin: Source, id: string, revision: string,
  publishedOn: string | null, attachments: { url: string; title: string }[] = []): void {
  const body = `<p>${revision}</p>`;
  const raw = {
    sourceId: origin.id,
    url: `https://example.edu/${id}/page.htm`,
    fetchedAt: "2026-09-23T10:00:00.000Z",
    contentType: "text/html",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  writer.ingestNotice(origin, raw, {
    sourceId: origin.id,
    sourceItemId: id,
    url: raw.url,
    title: revision,
    ...(publishedOn === null ? {} : { publishedAtRaw: publishedOn }),
    publishedOn,
    bodyText: revision,
    bodyHtml: body,
    attachments,
    provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
  });
}

async function serving(path: string): Promise<string> {
  const service = await startApi({ databasePath: path, host: "127.0.0.1", port: 0 });
  services.push(service);
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function response(base: string, path: string, method = "GET") {
  const result = await fetch(`${base}${path}`, { method });
  return { status: result.status, contentType: result.headers.get("content-type"),
    allow: result.headers.get("allow"), body: await result.json() };
}

describe("read-only API", () => {
  it("serves empty collections and a liveness response", async () => {
    const { path } = database();
    const base = await serving(path);
    expect(await response(base, "/v1/health")).toMatchObject({
      status: 200, contentType: "application/json; charset=utf-8", body: { data: { status: "ok" } },
    });
    for (const route of ["/v1/sources", "/v1/organizations", "/v1/notices/recent"]) {
      expect(await response(base, route)).toMatchObject({
        status: 200, contentType: "application/json; charset=utf-8", body: { data: [] },
      });
    }
  });

  it("preserves persisted summaries, current revisions, attachments, dates, and provenance", async () => {
    const { path, writer } = database();
    writer.upsertSource(sibling);
    notice(writer, source, "item-a", "old", "2026-09-21");
    notice(writer, source, "item-a", "new", null, [
      { url: "https://example.edu/first.pdf", title: "First" },
      { url: "https://example.edu/second.pdf", title: "Second" },
    ]);
    notice(writer, sibling, "item-b", "other", "2026-09-23");
    const reader = new InfoHubDatabaseReader(path);
    readers.push(reader);
    const base = await serving(path);
    expect((await response(base, "/v1/sources")).body).toEqual({ data: reader.listSources() });
    expect((await response(base, "/v1/organizations")).body).toEqual({ data: reader.listOrganizations() });
    const all = (await response(base, "/v1/notices/recent")).body;
    expect(all).toEqual({ data: reader.listRecentNotices() });
    expect(all.data.map((item: { title: string }) => item.title)).toEqual(["other", "new"]);
    expect(all.data[1]).toMatchObject({ publishedOn: null, revisionNumber: 2,
      attachments: [{ title: "First" }, { title: "Second" }],
      provenance: { fetchedAt: "2026-09-23T10:00:00.000Z" },
    });
    expect((await response(base, "/v1/notices/recent?sourceId=notices-a&organizationId=group-a&limit=1")).body)
      .toEqual({ data: reader.listRecentNotices({ sourceId: "notices-a", organizationId: "group-a", limit: 1 }) });
    expect((await response(base, "/v1/notices/recent?sourceId=notices-a&organizationId=group-b")).body)
      .toEqual({ data: [] });
    expect((await response(base, "/v1/notices/recent?sourceId=unknown")).body)
      .toEqual({ data: [] });
    expect((await response(base, "/v1/notices/recent?sourceId=notices-a%20")).body)
      .toEqual({ data: [] });
    for (const limit of [1, 100]) {
      expect((await response(base, `/v1/notices/recent?limit=${limit}`)).body)
        .toEqual({ data: reader.listRecentNotices({ limit }) });
    }
  });

  it("uses the database default limit when omitted", async () => {
    const { path, writer } = database();
    for (let index = 0; index < 51; index++) {
      notice(writer, source, `item-${index}`, `revision-${index}`, "2026-09-23");
    }
    const base = await serving(path);
    const recent = (await response(base, "/v1/notices/recent")).body;
    expect(recent.data).toHaveLength(50);
    expect((await response(base, "/v1/notices/recent?limit=100")).body.data).toHaveLength(51);
    expect((await response(base, "/feeds/notices-a.json")).body.items).toHaveLength(51);
  });

  it("serves up to 100 current persisted items as JSON Feed", async () => {
    const { path, writer } = database();
    notice(writer, source, "item-a", "old", "2026-09-21");
    notice(writer, source, "item-a", "new", "2026-09-23", [
      { url: "https://example.edu/first.pdf", title: "First" },
      { url: "https://example.edu/second.docx", title: "Second" },
    ]);
    const base = await serving(path);
    const result = await response(base, "/feeds/notices-a.json");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/feed+json; charset=utf-8");
    expect(result.body).toMatchObject({
      version: "https://jsonfeed.org/version/1.1",
      title: "First organization — First source",
      home_page_url: source.url,
      items: [{ id: "notices-a:item-a", url: "https://example.edu/item-a/page.htm",
        title: "new", content_html: "<p>new</p>", content_text: "new",
        date_published: "2026-09-23T00:00:00+08:00",
        attachments: [
          { mime_type: "application/pdf", title: "First" },
          { mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", title: "Second" },
        ],
        _nju: { published_on: "2026-09-23", date_precision: "day", revision_number: 2 },
      }],
    });
  });

  it("serves Atom and RSS with feed query, method, and unknown-source parity", async () => {
    const { path, writer } = database();
    notice(writer, source, "item-a", "new", "2026-09-23", [
      { url: "https://example.edu/a.pdf", title: "A" },
      { url: "https://example.edu/b.pdf", title: "B" },
    ]);
    const base = await serving(path);
    for (const [format, contentType, root] of [
      ["atom", "application/atom+xml; charset=utf-8", '<feed xmlns="http://www.w3.org/2005/Atom">'],
      ["rss", "application/rss+xml; charset=utf-8", '<rss version="2.0">'],
    ]) {
      const result = await fetch(`${base}/feeds/notices-a.${format}`);
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toBe(contentType);
      const document = await result.text();
      expect(document).toContain(root);
      expect(document).toContain("https://example.edu/item-a/page.htm");
      expect(document).toContain("notices-a:item-a");
      expect(document).toContain("https://example.edu/a.pdf");
      expect(document).toContain("https://example.edu/b.pdf");
      expect(await response(base, `/feeds/unknown.${format}`)).toMatchObject({ status: 404,
        body: { error: { code: "not_found" } },
      });
      for (const query of ["limit=1", "limit=1&limit=2"]) {
        expect(await response(base, `/feeds/notices-a.${format}?${query}`)).toMatchObject({ status: 400,
          body: { error: { code: "invalid_query" } },
        });
      }
      for (const method of ["POST", "PUT", "OPTIONS", "HEAD"]) {
        const rejected = await fetch(`${base}/feeds/notices-a.${format}`, { method });
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("uses source entries for feeds and leaves REST notices on the current-revision reader", async () => {
    const listRecentNotices = vi.fn(() => []);
    const listRecentSourceEntries = vi.fn(() => []);
    const listSources = vi.fn(() => [{ id: source.id, name: source.name,
      organization: source.organization, url: source.url, enabled: true }]);
    const server = createApiServer({ listSources, listRecentNotices, listRecentSourceEntries,
      listOrganizations: vi.fn(() => []) });
    extraServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    expect((await response(base, "/feeds/notices-a.json")).body).toMatchObject({
      items: [], _nju: { source_id: "notices-a" },
    });
    expect(listRecentSourceEntries).toHaveBeenCalledExactlyOnceWith({ sourceId: "notices-a", limit: 100 });
    expect(listRecentNotices).not.toHaveBeenCalled();
    expect(await response(base, "/feeds/unknown.json")).toMatchObject({
      status: 404, contentType: "application/json; charset=utf-8",
      body: { error: { code: "not_found", message: "Not found" } },
    });
    expect(listRecentSourceEntries).toHaveBeenCalledTimes(1);
    expect(listSources).toHaveBeenCalledTimes(2);
    for (const route of ["/feeds/notices-a.json?limit=1", "/feeds/notices-a.json?limit=1&limit=2"]) {
      expect(await response(base, route)).toMatchObject({ status: 400,
        body: { error: { code: "invalid_query", message: "Invalid query parameters" } },
      });
    }
    for (const method of ["POST", "PUT", "OPTIONS", "HEAD"]) {
      const result = await fetch(`${base}/feeds/notices-a.json`, { method });
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET");
      expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
      if (method !== "HEAD") {
        expect(await result.json()).toEqual({ error: { code: "method_not_allowed", message: "Method not allowed" } });
      }
    }
    expect(listSources).toHaveBeenCalledTimes(2);
    expect(listRecentSourceEntries).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, repeated, unknown, and misrouted query parameters", async () => {
    const base = await serving(database().path);
    const invalid = ["limit=0", "limit=101", "limit=1.5", "limit=-1", "limit=%2B1",
      "limit=1e1", "limit=", "limit=01", "limit=999999999999999999999999999",
      "sourceId=", "sourceId=%20", "organizationId=", "organizationId=%20",
      "limit=1&limit=2", "sourceId=a&sourceId=b", "other=1"];
    for (const query of invalid) {
      expect(await response(base, `/v1/notices/recent?${query}`)).toMatchObject({
        status: 400, contentType: "application/json; charset=utf-8",
        body: { error: { code: "invalid_query", message: "Invalid query parameters" } },
      });
    }
    for (const route of ["/v1/health", "/v1/sources", "/v1/organizations"]) {
      expect((await response(base, `${route}?limit=1`)).status).toBe(400);
    }
  });

  it("matches literal paths and permits only GET on known paths", async () => {
    const base = await serving(database().path);
    for (const route of ["/v1/sources/", "/V1/sources", "/missing"]) {
      expect(await response(base, route)).toMatchObject({
        status: 404, body: { error: { code: "not_found", message: "Not found" } },
      });
    }
    for (const method of ["POST", "PUT", "OPTIONS", "HEAD"]) {
      const result = await fetch(`${base}/v1/sources`, { method });
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET");
      expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
      if (method !== "HEAD") {
        expect(await result.json()).toEqual({ error: { code: "method_not_allowed", message: "Method not allowed" } });
      }
    }
    expect((await response(base, "/missing", "POST")).status).toBe(404);
  });

  it("sanitizes request-time database failures", async () => {
    const { path } = database();
    const reader = new InfoHubDatabaseReader(path);
    const server = createApiServer(reader);
    extraServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    reader.close();
    const result = await response(`http://127.0.0.1:${address.port}`, "/v1/sources");
    expect(result).toMatchObject({ status: 500,
      body: { error: { code: "internal_error", message: "Internal server error" } },
    });
    expect(JSON.stringify(result.body)).not.toContain(path);
    expect(JSON.stringify(result.body)).not.toContain("SQLite");
  });
});

describe("API startup and shutdown", () => {
  it("validates CLI arguments and resolves the database path", () => {
    expect(parseArgs(["--", "relative.sqlite"])).toEqual({
      databasePath: join(process.cwd(), "relative.sqlite"), host: "127.0.0.1", port: 3000,
    });
    expect(parseArgs(["db.sqlite", "--port", "443", "--host", "localhost"])).toMatchObject({
      host: "localhost", port: 443,
    });
    for (const port of ["1", "65535"]) {
      expect(parseArgs(["db.sqlite", "--port", port]).port).toBe(Number(port));
    }
    for (const args of [[], ["--host", "localhost"], ["db", "extra"],
      ["db", "--host", ""], ["db", "--port"], ["db", "--unknown", "x"],
      ["db", "--host", "a", "--host", "b"], ["db", "--port", "1", "--port", "2"],
      ...["0", "65536", "-1", "1.5", "+1", "01", "1e2", ""].map((port) => ["db", "--port", port])]) {
      expect(() => parseArgs(args)).toThrow();
    }
  });

  it("rejects missing and obsolete databases without creation or migration", async () => {
    const { path, writer } = database();
    const missing = `${path}-missing`;
    await expect(startApi({ databasePath: missing, host: "127.0.0.1", port: 0 })).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    writer.close();
    writers.splice(writers.indexOf(writer), 1);
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA user_version = 1");
    sqlite.close();
    const before = readFileSync(path);
    await expect(startApi({ databasePath: path, host: "127.0.0.1", port: 0 }))
      .rejects.toThrow("unsupported database schema version 1");
    expect(readFileSync(path)).toEqual(before);
  });

  it("closes the reader on listen failure and closes once after shutdown", async () => {
    const { path } = database();
    const close = vi.spyOn(InfoHubDatabaseReader.prototype, "close");
    const base = await serving(path);
    const service = services[0];
    if (!service) throw new Error("missing service");
    const address = service.server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    await expect(startApi({ databasePath: path, host: "127.0.0.1", port: address.port }))
      .rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await response(base, "/v1/health")).status).toBe(200);
    await Promise.all([service.close(), service.close()]);
    expect(close).toHaveBeenCalledTimes(2);
    services.splice(services.indexOf(service), 1);
    expect(service.server.listening).toBe(false);
  });
});
