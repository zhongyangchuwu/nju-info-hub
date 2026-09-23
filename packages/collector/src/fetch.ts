import { createHash } from "node:crypto";
import type { RawDocument } from "@nju-info/core";

const USER_AGENT =
  "nju-info-hub/0.1 (+https://github.com/zhongyangchuwu/nju-info-hub)";

export interface FetchValidators {
  etag?: string;
  lastModified?: string;
}

function detectCharset(contentType: string | null, bytes: Uint8Array): string {
  const headerCharset = contentType?.match(
    /charset\s*=\s*["']?([^;"'\s]+)/i,
  )?.[1];
  if (headerCharset) return headerCharset;

  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const metaCharset =
    prefix.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>]+)/i)?.[1] ??
    prefix.match(
      /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^;"'\s]+)/i,
    )?.[1];

  return metaCharset ?? "utf-8";
}

function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const charset = detectCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  headers: Headers,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!retryableStatus(response.status) || attempt === 3) return response;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`GET ${url} failed after retries: ${message}`, {
    cause: lastError,
  });
}

export async function fetchRawDocument(
  sourceId: string,
  url: string,
): Promise<RawDocument>;
export async function fetchRawDocument(
  sourceId: string,
  url: string,
  validators: FetchValidators,
): Promise<RawDocument | null>;
export async function fetchRawDocument(
  sourceId: string,
  url: string,
  validators?: FetchValidators,
): Promise<RawDocument | null> {
  const headers = new Headers({
    accept: "text/html,application/xhtml+xml",
    "user-agent": USER_AGENT,
  });

  if (validators?.etag) headers.set("if-none-match", validators.etag);
  if (validators?.lastModified) {
    headers.set("if-modified-since", validators.lastModified);
  }

  const response = await fetchWithRetry(url, headers);

  if (response.status === 304) return null;

  if (!response.ok) {
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = decodeHtml(bytes, contentType);
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");

  return {
    sourceId,
    url,
    fetchedAt: new Date().toISOString(),
    contentType,
    body,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}
