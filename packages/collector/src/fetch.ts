import { createHash } from 'node:crypto';
import type { RawDocument } from '@nju-info/core';

const USER_AGENT =
  'nju-info-hub/0.1 (+https://github.com/zhongyangchuwu/nju-info-hub)';

export async function fetchRawDocument(
  sourceId: string,
  url: string,
): Promise<RawDocument> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': USER_AGENT,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  return {
    sourceId,
    url: response.url,
    fetchedAt: new Date().toISOString(),
    contentType: response.headers.get('content-type'),
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

