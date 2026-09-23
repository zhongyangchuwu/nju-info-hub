import { createServer, type Server, type ServerResponse } from "node:http";
import { InfoHubDatabaseReader, type RecentNoticeOptions } from "@nju-info/db";
import type { ApiConfig } from "./config.js";
import { buildJsonFeed } from "./feed.js";
import { buildAtomFeed, buildRssFeed } from "./xml-feeds.js";

const paths: Record<string, true> = {
  "/v1/health": true,
  "/v1/sources": true,
  "/v1/organizations": true,
  "/v1/notices/recent": true,
};

type Reader = Pick<InfoHubDatabaseReader,
  "listSources" | "listOrganizations" | "listRecentNotices">;

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
        const notices = reader.listRecentNotices({ sourceId: feedSourceId, limit: 100 });
        if (feedMatch?.[2] === "json") {
          json(response, 200, buildJsonFeed(source, notices), undefined, "application/feed+json; charset=utf-8");
        } else {
          const atom = feedMatch?.[2] === "atom";
          const document = atom ? buildAtomFeed(source, notices) : buildRssFeed(source, notices);
          response.writeHead(200, { "Content-Type": atom
            ? "application/atom+xml; charset=utf-8" : "application/rss+xml; charset=utf-8" });
          response.end(document);
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
