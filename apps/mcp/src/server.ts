import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { InfoHubDatabaseReader } from "@nju-info/db";
import { z } from "zod";

const organization = z.object({ id: z.string(), name: z.string() });
const source = z.object({
  id: z.string(), name: z.string(), organization, url: z.string(),
});
const attachment = z.object({
  url: z.string(), title: z.string(), mediaType: z.string().optional(),
});
const notice = z.object({
  sourceId: z.string(), sourceItemId: z.string(), sourceName: z.string(),
  organization, revisionNumber: z.number().int(), url: z.string(), title: z.string(),
  publishedAtRaw: z.string().nullable(), publishedOn: z.string().nullable(),
  bodyText: z.string(), bodyHtml: z.string(), attachments: z.array(attachment),
  provenance: z.object({ fetchedAt: z.string(), contentSha256: z.string() }),
});
const emptyInput = z.strictObject({});
const recentInput = z.strictObject({
  sourceId: z.string().refine((value) => value.trim().length > 0).optional(),
  organizationId: z.string().refine((value) => value.trim().length > 0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const sourcesOutput = z.object({ sources: z.array(source) });
const organizationsOutput = z.object({ organizations: z.array(organization) });
const noticesOutput = z.object({ notices: z.array(notice) });
const annotations = { readOnlyHint: true, openWorldHint: false } as const;

type Reader = Pick<InfoHubDatabaseReader,
  "listSources" | "listOrganizations" | "listRecentNotices" | "close">;

function query(run: () => Record<string, unknown>): CallToolResult {
  try {
    const value = run();
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  } catch {
    return { isError: true, content: [{ type: "text", text: "Database query failed" }] };
  }
}

export function createMcpServer(reader: Reader, onClose: () => void = () => reader.close()): McpServer {
  const server = new McpServer({ name: "nju-info-hub", version: "0.0.0" });
  let closed = false;
  server.server.onclose = () => {
    if (closed) return;
    closed = true;
    onClose();
  };

  server.registerTool("list_sources", {
    description: "List persisted public sources and their organizations and URLs.",
    inputSchema: emptyInput, outputSchema: sourcesOutput, annotations,
  }, () => query(() => ({ sources: reader.listSources() })));

  server.registerTool("list_organizations", {
    description: "List organizations represented by persisted public sources.",
    inputSchema: emptyInput, outputSchema: organizationsOutput, annotations,
  }, () => query(() => ({ organizations: reader.listOrganizations() })));

  server.registerTool("list_recent_notices", {
    description: "List current recent notices, optionally filtered by source and organization (default 50, maximum 100).",
    inputSchema: recentInput, outputSchema: noticesOutput, annotations,
  }, (options) => query(() => ({ notices: reader.listRecentNotices({
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }) })));

  return server;
}
