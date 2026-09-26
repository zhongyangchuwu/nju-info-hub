import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { InfoHubDatabaseReader, type RecentNoticeOptions } from "@nju-info/db";
import type { ApiConfig } from "./config.js";
import {
  buildAtomFeed,
  buildJsonFeed,
  buildRssFeed,
  feedRecentItemLimit,
} from "@nju-info/feed";

const paths: Record<string, true> = {
  "/v1/health": true,
  "/v1/sources": true,
  "/v1/organizations": true,
  "/v1/notices/recent": true,
};

type Reader = Pick<InfoHubDatabaseReader,
  "listSources" | "listOrganizations" | "listRecentNotices" | "listRecentSourceEntries">;

function json(response: ServerResponse, status: number, body: unknown, allow?: string,
  contentType = "application/json; charset=utf-8"): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    ...(allow === undefined ? {} : { Allow: allow }),
  });
  response.end(JSON.stringify(body));
}

function error(response: ServerResponse, status: number, code: string, message: string, allow?: string): void {
  json(response, status, { error: { code, message } }, allow);
}


function feedEtag(body: string): string {
  const digest = createHash("sha256").update(body).digest("base64url");
  return `"sha256-${digest}"`;
}

function feedLastModified(entries: ReturnType<Reader["listRecentSourceEntries"]>): string | undefined {
  let latest = 0;
  for (const entry of entries) {
    const time = Date.parse(entry.provenance.fetchedAt);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  if (latest === 0) return undefined;
  return new Date(Math.floor(latest / 1000) * 1000).toUTCString();
}

function weakEtag(value: string): string {
  return value.trim().replace(/^W\//, "");
}

function ifNoneMatchMatches(value: string | string[] | undefined, etag: string): boolean {
  if (value === undefined) return false;
  const combined = Array.isArray(value) ? value.join(",") : value;
  return combined.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || weakEtag(trimmed) === weakEtag(etag);
  });
}

function conditionalFeed(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  contentType: string,
  entries: ReturnType<Reader["listRecentSourceEntries"]>,
): void {
  const etag = feedEtag(body);
  const lastModified = feedLastModified(entries);
  const ifNoneMatch = request.headers["if-none-match"];
  let notModified = ifNoneMatchMatches(ifNoneMatch, etag);

  if (ifNoneMatch === undefined && lastModified !== undefined) {
    const value = request.headers["if-modified-since"];
    const header = Array.isArray(value) ? value[0] : value;
    if (header !== undefined) {
      const modifiedSince = Date.parse(header);
      const current = Date.parse(lastModified);
      if (Number.isFinite(modifiedSince) && modifiedSince >= current) notModified = true;
    }
  }

  const cacheHeaders = {
    ETag: etag,
    "Cache-Control": "public, max-age=0, must-revalidate",
    ...(lastModified === undefined ? {} : { "Last-Modified": lastModified }),
  };
  if (notModified) {
    response.writeHead(304, cacheHeaders);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": contentType, ...cacheHeaders });
  response.end(body);
}

function recentOptions(params: URLSearchParams): RecentNoticeOptions | undefined {
  const options: RecentNoticeOptions = {};
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (key === "sourceId" || key === "organizationId") {
      if (!value.trim()) return undefined;
      options[key] = value;
    } else if (key === "limit") {
      if (!/^[1-9][0-9]*$/.test(value)) return undefined;
      const limit = Number(value);
      if (limit > 100) return undefined;
      options.limit = limit;
    } else {
      return undefined;
    }
  }
  return options;
}

export function createApiServer(reader: Reader): Server {
  return createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://localhost");
    } catch {
      error(response, 400, "invalid_query", "Invalid query parameters");
      return;
    }
    const path = (request.url ?? "").split("?", 1)[0];
    const feedMatch = /^\/feeds\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(json|atom|rss)$/.exec(path ?? "");
    const feedSourceId = feedMatch?.[1];
    if (path === undefined || (paths[path] !== true && feedSourceId === undefined)) {
      error(response, 404, "not_found", "Not found");
      return;
    }
    if (request.method !== "GET") {
      error(response, 405, "method_not_allowed", "Method not allowed", "GET");
      return;
    }
    const options = path === "/v1/notices/recent"
      ? recentOptions(url.searchParams)
      : url.searchParams.size === 0 ? {} : undefined;
    if (options === undefined) {
      error(response, 400, "invalid_query", "Invalid query parameters");
      return;
    }

    try {
      if (feedSourceId !== undefined) {
        const source = reader.listSources().find((candidate) => candidate.id === feedSourceId);
        if (source === undefined) {
          error(response, 404, "not_found", "Not found");
          return;
        }
        const sourceEntries = reader.listRecentSourceEntries({
          sourceId: feedSourceId,
          limit: feedRecentItemLimit,
        });
        if (feedMatch?.[2] === "json") {
          conditionalFeed(
            request,
            response,
            JSON.stringify(buildJsonFeed(source, sourceEntries)),
            "application/feed+json; charset=utf-8",
            sourceEntries,
          );
        } else {
          const atom = feedMatch?.[2] === "atom";
          conditionalFeed(
            request,
            response,
            atom ? buildAtomFeed(source, sourceEntries) : buildRssFeed(source, sourceEntries),
            atom ? "application/atom+xml; charset=utf-8" : "application/rss+xml; charset=utf-8",
            sourceEntries,
          );
        }
        return;
      }
      switch (path) {
        case "/v1/health":
          json(response, 200, { data: { status: "ok" } });
          break;
        case "/v1/sources":
          json(response, 200, { data: reader.listSources() });
          break;
        case "/v1/organizations":
          json(response, 200, { data: reader.listOrganizations() });
          break;
        case "/v1/notices/recent":
          json(response, 200, { data: reader.listRecentNotices(options) });
          break;
      }
    } catch {
      if (!response.headersSent) {
        error(response, 500, "internal_error", "Internal server error");
      }
    }
  });
}

export interface ApiService {
  server: Server;
  close(): Promise<void>;
}

export async function startApi(config: ApiConfig): Promise<ApiService> {
  const reader = new InfoHubDatabaseReader(config.databasePath);
  const server = createApiServer(reader);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (failure: Error) => {
        server.off("listening", onListening);
        reject(failure);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(config.port, config.host);
      } catch (failure) {
        server.off("error", onError);
        server.off("listening", onListening);
        reject(failure);
      }
    });
  } catch (failure) {
    reader.close();
    throw failure;
  }

  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close((failure) => {
        try {
          reader.close();
          if (failure) reject(failure);
          else resolve();
        } catch (closeFailure) {
          reject(closeFailure);
        }
      });
    }),
  };
}
