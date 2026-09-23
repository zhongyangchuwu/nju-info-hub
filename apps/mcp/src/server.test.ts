import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InfoHubDatabase, InfoHubDatabaseReader } from "@nju-info/db";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";

const source = {
  schemaVersion: 1 as const, id: "source-a", name: "First source",
  organization: { id: "group-a", name: "First organization" },
  url: "https://example.edu/a/list.htm", audience: ["students"],
  categories: ["notices"], enabled: true, adapter: { type: "webplus" as const },
};
const sibling = {
  ...source, id: "source-b", name: "Second source", enabled: false,
  organization: { id: "group-b", name: "Second organization" },
};
const dirs: string[] = [];
const clients: Client[] = [];
const writers: InfoHubDatabase[] = [];
const readers: InfoHubDatabaseReader[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const reader of readers.splice(0)) reader.close();
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "nju-info-mcp-"));
  dirs.push(dir);
  const path = join(dir, "test.sqlite");
  const writer = new InfoHubDatabase(path);
  writers.push(writer);
  return { path, writer };
}

function addNotice(writer: InfoHubDatabase, origin: typeof source, item: string, title: string,
  publishedOn: string | null, attachments: { url: string; title: string; mediaType?: string }[] = []) {
  const body = `<p>${title}</p>`;
  const raw = {
    sourceId: origin.id, url: `https://example.edu/${item}/page.htm`,
    fetchedAt: "2026-09-23T10:00:00.000Z", contentType: "text/html", body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  writer.ingestNotice(origin, raw, {
    sourceId: origin.id, sourceItemId: item, url: raw.url, title,
    ...(publishedOn === null ? {} : { publishedAtRaw: publishedOn }), publishedOn,
    bodyText: title, bodyHtml: body, attachments,
    provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
  });
}

async function connected(reader: InfoHubDatabaseReader) {
  const server = createMcpServer(reader);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(clientTransport);
  return client;
}

async function result(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).not.toBe(true);
  expect(response.content).toHaveLength(1);
  const text = response.content[0];
  expect(text?.type).toBe("text");
  if (text?.type !== "text") throw new Error("expected JSON text");
  expect(JSON.parse(text.text)).toEqual(response.structuredContent);
  return response.structuredContent;
}

it("lists exactly three read-only closed-world tools with input and output schemas", async () => {
  const { path } = database();
  const client = await connected(new InfoHubDatabaseReader(path));
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "list_organizations", "list_recent_notices", "list_sources",
  ]);
  for (const tool of tools) {
    expect(tool.description?.length).toBeGreaterThan(20);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema?.type).toBe("object");
  }
});

it("passes through reader summaries, filters, current revision, dates, attachments, and provenance", async () => {
  const { path, writer } = database();
  writer.upsertSource(sibling);
  addNotice(writer, source, "item-a", "old", "2026-09-21");
  addNotice(writer, source, "item-a", "new", null, [
    { url: "https://example.edu/first.pdf", title: "First", mediaType: "application/pdf" },
  ]);
  addNotice(writer, sibling, "item-b", "other", "2026-09-23");
  const reader = new InfoHubDatabaseReader(path);
  readers.push(reader);
  const client = await connected(new InfoHubDatabaseReader(path));
  expect(await result(client, "list_sources")).toEqual({ sources: reader.listSources() });
  expect(await result(client, "list_organizations")).toEqual({ organizations: reader.listOrganizations() });
  const cases = [{}, { sourceId: "source-a" }, { organizationId: "group-a" },
    { sourceId: "source-a", organizationId: "group-a" },
    { sourceId: "source-a", organizationId: "group-b" },
    { limit: 1 }, { limit: 100 }, { sourceId: "missing" },
    { organizationId: "missing" }, { sourceId: "source-a " }];
  for (const options of cases) {
    expect(await result(client, "list_recent_notices", options))
      .toEqual({ notices: reader.listRecentNotices(options) });
  }
  expect(await result(client, "list_recent_notices")).toEqual({ notices: reader.listRecentNotices() });
  expect(reader.listRecentNotices({ sourceId: "source-a" })[0]).toMatchObject({
    title: "new", revisionNumber: 2, publishedOn: null,
    attachments: [{ title: "First", mediaType: "application/pdf" }],
    provenance: { fetchedAt: "2026-09-23T10:00:00.000Z" },
  });
});

it("keeps the reader default limit when omitted", async () => {
  const { path, writer } = database();
  for (let i = 0; i < 51; i++) addNotice(writer, source, `item-${i}`, `notice-${i}`, "2026-09-23");
  const client = await connected(new InfoHubDatabaseReader(path));
  expect((await result(client, "list_recent_notices") as { notices: unknown[] }).notices).toHaveLength(50);
  expect((await result(client, "list_recent_notices", { limit: 100 }) as { notices: unknown[] }).notices).toHaveLength(51);
});

it("rejects invalid inputs before invoking the reader and sanitizes query-time failures", async () => {
  const failure = new Error("SQLite /secret/path: SELECT * FROM private_table");
  const reader = {
    listSources: vi.fn(() => { throw failure; }),
    listOrganizations: vi.fn(() => { throw failure; }),
    listRecentNotices: vi.fn(() => { throw failure; }),
    close: vi.fn(),
  };
  const client = await connected(reader as unknown as InfoHubDatabaseReader);
  for (const args of [{ sourceId: "" }, { sourceId: " \t " },
    { organizationId: "" }, { organizationId: " \n" },
    ...[0, 101, -1, 1.5, "1", null].map((limit) => ({ limit })), { extra: 1 }]) {
    const response = await client.callTool({ name: "list_recent_notices", arguments: args })
      .catch(() => ({ isError: true }));
    expect(response.isError).toBe(true);
  }
  for (const name of ["list_sources", "list_organizations"]) {
    const response = await client.callTool({ name, arguments: { extra: 1 } })
      .catch(() => ({ isError: true }));
    expect(response.isError).toBe(true);
  }
  expect(reader.listSources).not.toHaveBeenCalled();
  expect(reader.listOrganizations).not.toHaveBeenCalled();
  expect(reader.listRecentNotices).not.toHaveBeenCalled();
  for (const name of ["list_sources", "list_organizations", "list_recent_notices"]) {
    const response = await client.callTool({ name });
    expect(response.isError).toBe(true);
    expect(response).toEqual({
      content: [{ type: "text", text: "Database query failed" }], isError: true,
    });
    expect(JSON.stringify(response)).not.toMatch(/SQLite|secret|SELECT|private_table/);
  }
  await client.close();
  clients.splice(clients.indexOf(client), 1);
  expect(reader.close).toHaveBeenCalledTimes(1);
});

it("launches actual stdio server with official client and reaps the child on close", async () => {
  const { path, writer } = database();
  writer.upsertSource(source);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "apps/mcp/src/cli.ts", path],
    cwd: join(import.meta.dirname, "../../.."), stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  expect(transport.pid).not.toBeNull();
  expect(await result(client, "list_sources")).toEqual({ sources: [
    { id: "source-a", name: "First source", organization: source.organization,
      url: source.url, enabled: true },
  ] });
  expect(await result(client, "list_recent_notices")).toEqual({ notices: [] });
  expect(diagnostics).toBe("");
  await client.close();
  clients.splice(clients.indexOf(client), 1);
  expect(transport.pid).toBeNull();
});

it("fails missing and obsolete database startup without creating or migrating them", () => {
  const { path, writer } = database();
  const cli = join(import.meta.dirname, "cli.ts");
  const invoke = (db: string) => spawnSync(process.execPath, ["--import", "tsx", cli, db], {
    cwd: join(import.meta.dirname, "../../.."), encoding: "utf8", timeout: 10_000,
  });
  const missing = `${path}-missing`;
  const absent = invoke(missing);
  expect(absent.status).not.toBe(0);
  expect(absent.stdout).toBe("");
  expect(existsSync(missing)).toBe(false);
  writer.close();
  writers.splice(writers.indexOf(writer), 1);
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA user_version = 1");
  sqlite.close();
  const before = readFileSync(path);
  const obsolete = invoke(path);
  expect(obsolete.status).not.toBe(0);
  expect(obsolete.stderr).toContain("unsupported database schema version 1");
  expect(obsolete.stdout).toBe("");
  expect(readFileSync(path)).toEqual(before);
});
