import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InfoHubDatabase } from "@nju-info/db";
import { afterEach, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const cli = join(import.meta.dirname, "cli.ts");
const dirs: string[] = [];
const clients: Client[] = [];

const source = {
  schemaVersion: 1 as const,
  id: "source-a",
  name: "First source",
  organization: { id: "group-a", name: "First organization" },
  url: "https://example.edu/a/list.htm",
  adapter: { type: "webplus" as const },
};

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "nju-info-cli-"));
  dirs.push(dir);
  const path = join(dir, "test.sqlite");
  const writer = new InfoHubDatabase(path);
  return { path, writer };
}

function addNotice(writer: InfoHubDatabase): void {
  const body = "<p>notice</p>";
  const raw = {
    sourceId: source.id,
    url: "https://example.edu/a/page.htm",
    fetchedAt: "2026-09-23T10:00:00.000Z",
    contentType: "text/html",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  writer.ingestNotice(source, raw, {
    sourceId: source.id,
    sourceItemId: "item-a",
    url: raw.url,
    title: "Notice",
    publishedAtRaw: "2026-09-23",
    publishedOn: "2026-09-23",
    bodyText: "notice",
    bodyHtml: body,
    attachments: [],
    provenance: { fetchedAt: raw.fetchedAt, contentSha256: raw.sha256 },
  });
}

function invoke(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
}

it("validates the official instance through the root product command", () => {
  const result = spawnSync(
    "pnpm",
    ["nju-info", "--", "validate", "instances/official.json", "sources/nju"],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it("launches MCP stdio through the product CLI", async () => {
  const { path, writer } = database();
  writer.upsertSource(source);
  addNotice(writer);
  writer.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", cli, "mcp", path],
    cwd: repoRoot,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const client = new Client({ name: "product-cli-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  const response = await client.callTool({ name: "list_sources" });
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toEqual({
    sources: [{
      id: source.id,
      name: source.name,
      organization: source.organization,
      url: source.url,
    }],
  });
  expect(diagnostics).toBe("");
});

it("rejects missing and obsolete databases without creating or migrating them", () => {
  const { path, writer } = database();
  writer.close();

  const missing = `${path}-missing`;
  const absent = invoke("mcp", missing);
  expect(absent.status).not.toBe(0);
  expect(absent.stdout).toBe("");
  expect(existsSync(missing)).toBe(false);

  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA user_version = 1");
  sqlite.close();
  const before = readFileSync(path);
  const obsolete = invoke("mcp", path);
  expect(obsolete.status).not.toBe(0);
  expect(obsolete.stderr).toContain("unsupported database schema version 1");
  expect(obsolete.stdout).toBe("");
  expect(readFileSync(path)).toEqual(before);
});

it("rejects mutable official GHCR image references before running a command", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "validate"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NJU_INFO_IMAGE_REF: "ghcr.io/zhongyangchuwu/nju-info-hub:latest",
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("official GHCR image must use an immutable");
});
