import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startGateway } from './server.js';
import type { GatewayConfig } from './config.js';

const readerToken = 'synthetic-reader-token';
const upstreamToken = 'synthetic-upstream-token';
const allowedUin = '123456789';
const feedPath = '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/feed';
const detailPath = '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/detail';
const feedJson = JSON.stringify({ ok: true, data: { items: [] } });

const gateways: Array<{ close(): Promise<void> }> = [];
const upstreams: Server[] = [];
let upstreamCount = 0;
let upstreamRequests: Array<{ url: string | undefined; headers: IncomingMessage['headers'] }> = [];
let upstreamOrigin = '';
let upstreamHandler: (request: IncomingMessage, response: ServerResponse) => void;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function runningGateway() {
  upstreamCount = 0;
  upstreamRequests = [];
  upstreamHandler = (_request, response) => sendJson(response, 200, { ok: true, data: { items: [] } });
  const upstream = createServer((request, response) => {
    upstreamCount += 1;
    upstreamRequests.push({ url: request.url, headers: request.headers });
    upstreamHandler(request, response);
  });
  upstreams.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('expected upstream TCP address');
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  const service = await startGateway({ upstreamOrigin,
    upstreamToken, readerToken, publisherUins: [allowedUin], host: '127.0.0.1', port: 0 } satisfies GatewayConfig);
  gateways.push(service);
  const gatewayAddress = service.server.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('expected gateway TCP address');
  return `http://127.0.0.1:${gatewayAddress.port}`;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of upstreams.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function rawRequest(base: string, target: string, options: {
  method?: string; headers?: Record<string, string> | string[]; body?: string;
} = {}) {
  const address = new URL(base);
  return await new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: address.hostname, port: Number(address.port), method: options.method ?? 'GET',
      path: target, headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function duplicateAuthorizationRequest(base: string, target: string) {
  const address = new URL(base);
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: address.hostname, port: Number(address.port), path: target }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.setHeader('Authorization', `Bearer ${readerToken}`);
    request.appendHeader('Authorization', `Bearer ${readerToken}`);
    request.end();
  });
}

async function authorized(base: string, target: string, options: {
  method?: string; headers?: Record<string, string> | string[]; body?: string;
} = {}) {
  return rawRequest(base, target, { ...options, headers: { authorization: `Bearer ${readerToken}`,
    ...(typeof options.headers === 'object' && !Array.isArray(options.headers) ? options.headers : {}) } });
}


function expectSafeFailure(response: { status: number; headers: IncomingMessage['headers']; body: string }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(JSON.parse(response.body)).toEqual({ error: { code } });
  for (const secret of [readerToken, upstreamToken, upstreamOrigin, 'provider-private-sentinel',
    'caller-cookie-sentinel', 'caller-private-sentinel']) {
    expect(response.body).not.toContain(secret);
    expect(JSON.stringify(response.headers)).not.toContain(secret);
  }
}

describe('QZone gateway read-only boundary', () => {
  it.each([1, 10])('forwards only the canonical allowlisted profile feed at limit %i', async (limit) => {
    const base = await runningGateway();
    upstreamHandler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'Application/JSON; charset=utf-8',
        'set-cookie': 'provider=provider-private-sentinel', location: '/private', etag: 'private-etag-sentinel',
        'x-private-upstream': 'provider-private-sentinel' });
      response.end(feedJson);
    };
    const response = await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=${limit}`, {
      headers: { cookie: 'caller-cookie-sentinel', 'x-private-caller': 'caller-private-sentinel',
        'x-forwarded-for': '192.0.2.77' },
    });
    expect(response.body).toBe(feedJson);
    expect(upstreamCount).toBe(1);
    expect(upstreamRequests[0]?.url).toBe(`${feedPath}?scope=profile&hostuin=${allowedUin}&limit=${limit}`);
    expect(upstreamRequests[0]?.headers.authorization).toBe(`Bearer ${upstreamToken}`);
    expect(upstreamRequests[0]?.headers.accept).toBe('application/json');
    expect(upstreamRequests[0]?.headers.cookie).toBeUndefined();
    expect(upstreamRequests[0]?.headers['x-private-caller']).toBeUndefined();
    expect(upstreamRequests[0]?.headers['x-forwarded-for']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers.location).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['x-private-upstream']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('forwards mixed-case detail tids unchanged with only the upstream capability', async () => {
    const base = await runningGateway();
    const tid = 'MiXeD-Tid-Case';
    const response = await authorized(base, `${detailPath}?id=${allowedUin}:${tid}`, {
      headers: { cookie: 'caller-cookie-sentinel', 'x-private-caller': 'caller-private-sentinel' },
    });
    expect(response.status).toBe(200);
    expect(new URL(`http://upstream${upstreamRequests[0]?.url}`).pathname).toBe(detailPath);
    expect(new URL(`http://upstream${upstreamRequests[0]?.url}`).searchParams.get('id')).toBe(`${allowedUin}:${tid}`);
    expect(upstreamRequests[0]?.headers.authorization).toBe(`Bearer ${upstreamToken}`);
    expect(upstreamRequests[0]?.headers.cookie).toBeUndefined();
    expect(upstreamRequests[0]?.headers['x-private-caller']).toBeUndefined();
  });

  it('rejects unsupported methods, route variants, malformed queries and unlisted publishers before upstream access', async () => {
    const base = await runningGateway();
    const rejected: Array<{ target: string; method?: string; status: number; code: string }> = [];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      rejected.push({ target: `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`, method, status: 405, code: 'method-not-allowed' });
    }
    for (const target of [
      `${feedPath.toUpperCase()}?scope=profile&hostuin=${allowedUin}&limit=1`,
      `${feedPath}/?scope=profile&hostuin=${allowedUin}&limit=1`,
      '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/list?scope=profile&hostuin=123456789&limit=1',
      `/api/v1/plugins/extensions/astrbot_plugin_qzone/page/%66eed?scope=profile&hostuin=${allowedUin}&limit=1`,
      `/api/v1/plugins/extensions/astrbot_plugin_qzone/page/%2e%2e/feed?scope=profile&hostuin=${allowedUin}&limit=1`,
      `http://127.0.0.1${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`,
    ]) rejected.push({ target, status: 404, code: 'not-found' });
    for (const query of [
      `scope=friends&hostuin=${allowedUin}&limit=1`, `scope=self&hostuin=${allowedUin}&limit=1`,
      `scope=profile&hostuin=${allowedUin}&limit=1&cursor=x`, `hostuin=${allowedUin}&limit=1`,
      `scope=profile&hostuin=${allowedUin}`, `scope=profile&hostuin=${allowedUin}&limit=1&limit=1`,
      `scope=profile&hostuin=${allowedUin}&limit=0`, `scope=profile&hostuin=${allowedUin}&limit=11`,
      `scope=profile&hostuin=${allowedUin}&limit=01`, `scope=profile&hostuin=987654321&limit=1`,
      `scope=profile&hostuin=${allowedUin}&limit=1&scope=profile`,
    ]) rejected.push({ target: `${feedPath}?${query}`, status: query.includes('987654321') ? 403 : 400,
      code: query.includes('987654321') ? 'publisher-not-allowed' : 'invalid-request' });
    for (const test of rejected) {
      const response = await authorized(base, test.target, test.method === undefined ? {} : { method: test.method });
      if (test.method) expect(response.headers.allow).toBe('GET');
      if (test.method === 'HEAD') expect(response.status).toBe(405);
      else expectSafeFailure(response, test.status, test.code);
    }
    for (const target of [`${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1#fragment`,
      `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1&extra=%ZZ`]) {
      expectSafeFailure(await authorized(base, target), 400, 'invalid-request');
    }
    for (const query of ['id=', 'itemid=123456789:tid', 'id=123456789:tid&extra=x',
      'id=123456789:tid&id=123456789:other', 'id=:tid', 'id=123456789:',
      'id=123456789:has%20space', 'id=123456789:has%0Aline']) {
      expectSafeFailure(await authorized(base, `${detailPath}?${query}`), 400, 'invalid-request');
    }
    expectSafeFailure(await authorized(base, `${detailPath}?id=987654321:tid`), 403, 'publisher-not-allowed');
    expect(upstreamCount).toBe(0);
  });

  it('requires one exact reader bearer and rejects GET request bodies before forwarding', async () => {
    const base = await runningGateway();
    const target = `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`;
    const cases = [
      await rawRequest(base, target),
      await rawRequest(base, target, { headers: { authorization: 'Bearer wrong-synthetic-token' } }),
      await rawRequest(base, target, { headers: { authorization: `Bearer ${upstreamToken}` } }),
      await rawRequest(base, target, { headers: { authorization: 'Bearer synthetic-reader-token-expanded' } }),
      await duplicateAuthorizationRequest(base, target),
    ];
    for (const response of cases) expectSafeFailure(response, 401, 'unauthorized');
    expectSafeFailure(await rawRequest(base, target, { headers: { authorization: `Bearer ${readerToken}`, 'content-length': '4' }, body: 'body' }),
      400, 'invalid-request');
    expect(upstreamCount).toBe(0);
  });

  it('returns a safe not-found response for paths that do not exist', async () => {
    const base = await runningGateway();
    expectSafeFailure(await authorized(base, '/'), 404, 'not-found');
    expect(upstreamCount).toBe(0);
  });
  it('fails safely on a bind conflict and supports idempotent closure', async () => {
    const base = await runningGateway();
    const service = gateways.at(-1);
    if (!service) throw new Error('missing gateway service');
    const port = Number(new URL(base).port);
    await expect(startGateway({ upstreamOrigin: 'http://127.0.0.1:6185', upstreamToken, readerToken,
      publisherUins: [allowedUin], host: '127.0.0.1', port })).rejects.toThrow('QZone gateway failed to listen');
    await Promise.all([service.close(), service.close()]);
    gateways.splice(gateways.indexOf(service), 1);
    await expect(service.close()).resolves.toBeUndefined();
  });
});

describe('QZone gateway upstream handling', () => {
  it.each([
    { status: 400, mapped: 502, code: 'upstream-failure' },
    { status: 401, mapped: 502, code: 'upstream-failure' },
    { status: 403, mapped: 502, code: 'upstream-failure' },
    { status: 500, mapped: 502, code: 'upstream-failure' },
    { status: 429, mapped: 429, code: 'upstream-rate-limited' },
  ])('maps upstream status $status to a fixed safe response', async ({ status, mapped, code }) => {
    const base = await runningGateway();
    upstreamHandler = (_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain', 'x-private-upstream': 'provider-private-sentinel',
        'set-cookie': 'provider=provider-private-sentinel' });
      response.end('provider-private-sentinel synthetic-upstream-token');
    };
    const result = await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`);
    expectSafeFailure(result, mapped, code);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['x-private-upstream']).toBeUndefined();
  });

  it('does not follow even same-origin redirects', async () => {
    const base = await runningGateway();
    upstreamHandler = (_request, response) => response.writeHead(302, { location: '/redirect-target' }).end();
    const result = await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`);
    expectSafeFailure(result, 502, 'upstream-failure');
    expect(upstreamCount).toBe(1);
  });

  it.each([
    { name: 'HTML', type: 'text/html', body: '<html>provider-private-sentinel</html>' },
    { name: 'JSONP', type: 'application/javascript', body: 'callback({"ok":true})' },
    { name: 'JSONP MIME', type: 'application/jsonp', body: 'callback({"ok":true})' },
    { name: 'missing content type', type: undefined, body: feedJson },
    { name: 'invalid JSON', type: 'application/json', body: '{broken provider-private-sentinel' },
    { name: 'unexpected array JSON', type: 'application/json', body: '[]' },
    { name: 'missing ok marker', type: 'application/json', body: '{"data":true}' },
    { name: 'provider failure JSON', type: 'application/json', body: '{"ok":false,"error":"provider-private-sentinel"}', code: 'upstream-failure' },
  ])('rejects $name upstream responses without reflecting their content', async ({ type, body, code }) => {
    const base = await runningGateway();
    upstreamHandler = (_request, response) => {
      response.writeHead(200, { ...(type ? { 'content-type': type } : {}), 'x-private-upstream': 'provider-private-sentinel' });
      response.end(body);
    };
    expectSafeFailure(await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`), 502,
      code ?? 'invalid-upstream-response');
  });

  it('rejects invalid UTF-8 and actual oversize streamed bodies with fixed safe responses', async () => {
    const base = await runningGateway();
    upstreamHandler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(Buffer.from([0xc3, 0x28]));
    };
    expectSafeFailure(await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`), 502,
      'invalid-upstream-response');
    const oversized = `{"ok":true,"padding":"${'x'.repeat(2 * 1024 * 1024 + 1)}"}`;
    upstreamHandler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(oversized)) });
      response.end(oversized);
    };
    expectSafeFailure(await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`), 502,
      'invalid-upstream-response');
    upstreamHandler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":true,"padding":"');
      response.end('x'.repeat(2 * 1024 * 1024 + 1));
    };
    expectSafeFailure(await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`), 502,
      'invalid-upstream-response');
  });

  it('rejects token reflection after JSON normalization, including escaped JSON characters', async () => {
    const base = await runningGateway();
    for (const body of [
      JSON.stringify({ ok: true, data: { value: readerToken } }),
      JSON.stringify({ ok: true, data: { value: upstreamToken } }),
      '{"ok":true,"data":{"value":"synthetic-\\u0075pstream-token"}}',
      '{"ok":true,"data":{"synthetic-\\u0075pstream-token":"hidden"}}',
    ]) {
      upstreamHandler = (_request, response) => sendJson(response, 200, JSON.parse(body));
      // Preserve escaped spellings so decoded value and key reflection is detected.
      if (body.includes('\\u0075')) upstreamHandler = (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      };
      expectSafeFailure(await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`), 502,
        'invalid-upstream-response');
    }
  });

  it('returns fixed timeout status and error code when the upstream does not respond', async () => {
    const base = await runningGateway();
    upstreamHandler = () => { /* hold connection until gateway timeout */ };
    const result = await authorized(base, `${feedPath}?scope=profile&hostuin=${allowedUin}&limit=1`);
    expectSafeFailure(result, 504, 'upstream-timeout');
  }, 35_000);
});
