import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseGatewayConfig, type GatewayConfig } from './config.js';

const feedPath = '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/feed';
const detailPath = '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/detail';
const feedKeys: Record<string, true> = { scope: true, hostuin: true, limit: true };
const maxResponseBytes = 2 * 1024 * 1024;

type ErrorCode = 'unauthorized' | 'method-not-allowed' | 'not-found' | 'invalid-request' |
  'publisher-not-allowed' | 'upstream-failure' | 'upstream-rate-limited' |
  'upstream-timeout' | 'invalid-upstream-response';

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode) {
    super(code);
  }
}

function requestTarget(request: IncomingMessage, publishers: Set<string>): { pathname: string; params: URLSearchParams } {
  if (request.method !== 'GET') throw new GatewayError(405, 'method-not-allowed');
  if (request.headers['transfer-encoding'] ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
    throw new GatewayError(400, 'invalid-request');
  }
  const target = request.url ?? '';
  if (/[#\s\u0000-\u001f\u007f]/.test(target)) throw new GatewayError(400, 'invalid-request');
  const separator = target.indexOf('?');
  const pathname = separator === -1 ? target : target.slice(0, separator);
  // Compare raw paths: URL normalization must not broaden the operation allowlist.
  if (pathname !== feedPath && pathname !== detailPath) throw new GatewayError(404, 'not-found');
  const params = new URLSearchParams(separator === -1 ? '' : target.slice(separator + 1));
  if (pathname === feedPath) {
    const uin = params.get('hostuin');
    const limit = params.get('limit');
    if (params.size !== 3 || [...params.keys()].some((key) => !Object.hasOwn(feedKeys, key)) ||
        params.get('scope') !== 'profile' || uin === null || !/^[1-9]\d*$/.test(uin) ||
        limit === null || !/^(?:[1-9]|10)$/.test(limit)) {
      throw new GatewayError(400, 'invalid-request');
    }
    if (!publishers.has(uin)) throw new GatewayError(403, 'publisher-not-allowed');
    return { pathname, params: new URLSearchParams({ scope: 'profile', hostuin: uin, limit }) };
  }
  const id = params.get('id');
  if (params.size !== 1 || id === null) throw new GatewayError(400, 'invalid-request');
  const colon = id.indexOf(':');
  const uin = id.slice(0, colon);
  const tid = id.slice(colon + 1);
  if (colon < 1 || !/^[1-9]\d*$/.test(uin) || tid === '' || /[\s\u0000-\u001f\u007f]/.test(tid)) {
    throw new GatewayError(400, 'invalid-request');
  }
  if (!publishers.has(uin)) throw new GatewayError(403, 'publisher-not-allowed');
  return { pathname, params: new URLSearchParams({ id }) };
}

async function upstreamJson(url: URL, config: GatewayConfig, response: ServerResponse): Promise<string> {
  const timeout = AbortSignal.timeout(30_000);
  const disconnected = new AbortController();
  const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
  response.once('close', onClose);
  try {
    const upstream = await fetch(url, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${config.upstreamToken}` },
      redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([timeout, disconnected.signal]),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw upstream.status === 429 ? new GatewayError(429, 'upstream-rate-limited') : new GatewayError(502, 'upstream-failure');
    }
    const mime = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const declaredLength = upstream.headers.get('content-length');
    if (mime !== 'application/json' || (declaredLength !== null && Number(declaredLength) > maxResponseBytes)) {
      await upstream.body?.cancel();
      throw new GatewayError(502, 'invalid-upstream-response');
    }
    const reader = upstream.body?.getReader();
    if (!reader) throw new GatewayError(502, 'invalid-upstream-response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxResponseBytes) {
          await reader.cancel();
          throw new GatewayError(502, 'invalid-upstream-response');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
    } catch {
      throw new GatewayError(502, 'invalid-upstream-response');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('ok' in value)) {
      throw new GatewayError(502, 'invalid-upstream-response');
    }
    if (value.ok !== true) throw new GatewayError(502, 'upstream-failure');
    const body = JSON.stringify(value);
    // Canonical serialization catches literal and JSON-escaped reflection of either credential.
    if (body.includes(config.upstreamToken) || body.includes(config.readerToken)) {
      throw new GatewayError(502, 'invalid-upstream-response');
    }
    return body;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw timeout.aborted ? new GatewayError(504, 'upstream-timeout') : new GatewayError(502, 'upstream-failure');
  } finally {
    response.off('close', onClose);
  }
}

export function createGatewayServer(input: GatewayConfig): Server {
  const config = parseGatewayConfig({
    QZONE_GATEWAY_UPSTREAM_URL: input.upstreamOrigin,
    QZONE_GATEWAY_UPSTREAM_TOKEN: input.upstreamToken,
    QZONE_GATEWAY_READER_TOKEN: input.readerToken,
    QZONE_GATEWAY_PUBLISHER_UINS: input.publisherUins.join(','),
    QZONE_GATEWAY_HOST: input.host, QZONE_GATEWAY_PORT: String(input.port),
  });
  const expectedAuth = Buffer.from(`Bearer ${config.readerToken}`);
  const publishers = new Set(config.publisherUins);
  return createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, (request, response) => {
    const handle = async () => {
      let authHeaders = 0;
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]!.toLowerCase() === 'authorization') authHeaders += 1;
      }
      const actualAuth = Buffer.from(request.headers.authorization ?? '');
      if (authHeaders !== 1 || actualAuth.byteLength !== expectedAuth.byteLength || !timingSafeEqual(actualAuth, expectedAuth)) {
        throw new GatewayError(401, 'unauthorized');
      }
      const target = requestTarget(request, publishers);
      const url = new URL(target.pathname, config.upstreamOrigin);
      url.search = target.params.toString();
      const body = await upstreamJson(url, config, response);
      if (!response.destroyed) {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        });
        response.end(body);
      }
    };
    void handle().catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return;
      const failure = error instanceof GatewayError ? error : new GatewayError(502, 'upstream-failure');
      response.writeHead(failure.status, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        ...(failure.status === 405 ? { allow: 'GET' } : {}),
        ...(failure.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
        connection: 'close',
      });
      response.end(JSON.stringify({ error: { code: failure.code } }));
    });
  });
}

export interface GatewayService {
  server: Server;
  close(): Promise<void>;
}

export async function startGateway(config: GatewayConfig): Promise<GatewayService> {
  const server = createGatewayServer(config);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => { server.off('listening', onListening); reject(new Error('QZone gateway failed to listen')); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(config.port, config.host);
      } catch {
        server.off('error', onError);
        server.off('listening', onListening);
        reject(new Error('QZone gateway failed to listen'));
      }
    });
  } catch {
    server.close();
    throw new Error('QZone gateway failed to listen');
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close((failure) => failure ? reject(new Error('QZone gateway failed to close')) : resolve());
    }),
  };
}
