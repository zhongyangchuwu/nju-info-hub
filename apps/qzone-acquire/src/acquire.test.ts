import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireQzone } from './acquire.js';
import { AstrBotQzoneClient } from './client.js';
import { parseQzonePolicy, type QzoneRuntimeConfig } from './config.js';

const post = {
  id: '10001:CaseSensitiveTid', author: { uin: 10001, nickname: 'Ignored name', avatar: 'https://avatar.example' },
  content: 'Synthetic service notice', created_at: 1791331200,
  images: ['https://media.example/one.jpg', 'https://media.example/two.jpg'],
  comments: [{ content: 'excluded-comment', author: { uin: 999 } }],
  viewer: 'excluded-viewer', session: 'excluded-session', stats: { likes: 100 }, liked: true,
};
const selectedPost = {
  uin: '10001', tid: 'CaseSensitiveTid', created_at: post.created_at,
  content: post.content, mediaUrls: post.images,
};
const routeBase = '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/';

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

describe('isolated HTTP acquisition', () => {
  let root: string;
  let runtime: QzoneRuntimeConfig;
  let requests: { method: string | undefined; url: string | undefined }[];
  let respond: (req: IncomingMessage, res: ServerResponse) => void;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.headers.authorization !== `Bearer ${runtime.token}`) return json(res, { ok: false }, 401);
    respond(req, res);
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'qzone-acquisition-test-'));
    requests = [];
    respond = (req, res) => {
      const url = new URL(req.url!, runtime.origin);
      if (url.pathname === `${routeBase}feed` && url.searchParams.get('scope') === 'profile' &&
          url.searchParams.get('hostuin') === '10001') {
        json(res, { ok: true, data: { items: [post], cursor: '', has_more: false } });
      } else if (url.pathname === `${routeBase}detail` && url.searchParams.get('id') === post.id) {
        json(res, { ok: true, data: { post } });
      } else json(res, { ok: false }, 403);
    };
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP fixture server');
    runtime = {
      origin: `http://127.0.0.1:${address.port}`, token: 'synthetic-collector-capability',
      astrbotVersion: 'synthetic-astrbot-revision', pluginVersion: 'synthetic-plugin-revision',
      protectedRoot: `${root}-platform-state`,
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function policy() {
    return parseQzonePolicy(JSON.parse(await readFile(new URL('./fixtures/policy.json', import.meta.url), 'utf8')));
  }

  it('stores credential-free restricted raw bytes and canonical candidates with honest discovery gaps', async () => {
    const before = Date.now();
    const result = await acquireQzone(await policy(), runtime, root);
    expect(result).toMatchObject({ itemCount: 1, discoveryComplete: false });
    expect(await readdir(root)).toEqual([result.runId]);
    const runDirectory = path.join(root, result.runId);
    const manifest = JSON.parse(await readFile(path.join(runDirectory, 'run.json'), 'utf8'));
    const candidates = JSON.parse(await readFile(path.join(runDirectory, 'candidates.json'), 'utf8'));
    expect(manifest).toMatchObject({
      publicationEligible: false, evidenceTier: 'restricted',
      discovery: { complete: false, reason: 'provider-first-page-only', listedCount: 1, detailCount: 1 },
      provenance: { plugin: { name: 'astrbot_plugin_qzone', version: runtime.pluginVersion } },
    });
    expect(candidates[0]).toMatchObject({
      nativeIdentity: { scheme: 'qzone-tid', version: 1, tid: 'CaseSensitiveTid' },
      content: { text: post.content, html: '', completeness: 'partial' },
      rawEvidence: { evidenceTier: 'restricted', evidenceKind: 'provider-export' },
    });
    for (const [reference, expected] of [[manifest.feedEvidence, [selectedPost]], [candidates[0].rawEvidence, selectedPost]] as const) {
      const bytes = await readFile(path.join(runDirectory, 'blobs', reference.blob.sha256));
      expect(bytes.toString('utf8')).toBe(JSON.stringify(expected));
      expect(reference.blob.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(reference.blob.byteLength).toBe(bytes.byteLength);
      expect(Date.parse(reference.acquiredAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(reference.acquiredAt)).toBeLessThanOrEqual(Date.now());
      expect((await stat(path.join(runDirectory, 'blobs', reference.blob.sha256))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700);
    for (const filename of ['run.json', 'candidates.json']) {
      const bytes = await readFile(path.join(runDirectory, filename), 'utf8');
      for (const excluded of [runtime.token, runtime.origin, 'excluded-comment', 'excluded-viewer', 'excluded-session']) {
        expect(bytes).not.toContain(excluded);
      }
      expect((await stat(path.join(runDirectory, filename))).mode & 0o777).toBe(0o600);
    }
    expect(requests.map((request) => {
      const url = new URL(request.url!, runtime.origin);
      return { method: request.method, pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
    })).toEqual([
      { method: 'GET', pathname: '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/feed', params: { scope: 'profile', hostuin: '10001', limit: '10' } },
      { method: 'GET', pathname: '/api/v1/plugins/extensions/astrbot_plugin_qzone/page/detail', params: { id: '10001:CaseSensitiveTid' } },
    ]);
  });

  it('records empty discovery as incomplete rather than proving no posts exist', async () => {
    respond = (_req, res) => json(res, { ok: true, data: { items: [], cursor: '', has_more: false } });
    const result = await acquireQzone(await policy(), runtime, root);
    const manifest = JSON.parse(await readFile(path.join(root, result.runId, 'run.json'), 'utf8'));
    expect(result).toMatchObject({ itemCount: 0, discoveryComplete: false });
    expect(manifest.discovery).toMatchObject({ complete: false, listedCount: 0, detailCount: 0 });
    expect(requests).toHaveLength(1);
  });

  it.each([[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [400, 'provider'], [503, 'provider']] as const)(
    'fails HTTP %i safely without retries or empty success', async (status, code) => {
      respond = (_req, res) => json(res, { ok: false, error: { message: 'excluded-provider-secret' } }, status);
      await expect(acquireQzone(await policy(), runtime, root)).rejects.toMatchObject({ code, message: `QZone acquisition failed: ${code}` });
      expect(requests).toHaveLength(1);
      const directories = await readdir(root);
      expect(directories.every((entry) => entry.startsWith('.partial-'))).toBe(true);
      expect(await readdir(path.join(root, directories[0]!))).not.toContain('run.json');
    },
  );

  it('does not follow redirects carrying bearer authorization', async () => {
    respond = (_req, res) => { res.writeHead(302, { location: `${runtime.origin}/unexpected` }); res.end(); };
    await expect(new AstrBotQzoneClient(runtime, '10001').feed()).rejects.toMatchObject({ code: 'provider' });
    expect(requests).toHaveLength(1);
  });

  it.each(['html', 'invalid-json', 'ok-false', 'missing-items', 'oversize'])('rejects %s responses without retaining provider content', async (kind) => {
    respond = (_req, res) => {
      if (kind === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('excluded-secret-login-page'); }
      if (kind === 'invalid-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('excluded-invalid-json'); }
      if (kind === 'ok-false') json(res, { ok: false, error: { message: 'excluded-provider-secret' } });
      if (kind === 'missing-items') json(res, { ok: true, data: {} });
      if (kind === 'oversize') json(res, { ok: true, data: { items: [], cursor: 'x'.repeat(2 * 1024 * 1024), has_more: false } });
    };
    await expect(new AstrBotQzoneClient(runtime, '10001').feed()).rejects.toMatchObject({ code: kind === 'ok-false' ? 'provider' : 'invalid-response' });
    expect(requests).toHaveLength(1);
  });

  it('never requests details outside the successfully discovered allowlisted profile', async () => {
    const client = new AstrBotQzoneClient(runtime, '10001');
    await expect(client.detail(selectedPost)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toHaveLength(0);
    await client.feed();
    await expect(client.detail({ ...selectedPost, uin: '20002' })).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toHaveLength(1);
  });

  it.each(['foreign', 'duplicate', 'too-many'])('rejects %s feed rows before requesting any details', async (kind) => {
    const items = kind === 'foreign' ? [{ ...post, id: '20002:OtherTid', author: { uin: 20002 } }] :
      kind === 'duplicate' ? [post, post] : Array.from({ length: 11 }, (_, index) => ({ ...post, id: `10001:Tid${index}` }));
    respond = (_req, res) => json(res, { ok: true, data: { items, cursor: '', has_more: false } });
    await expect(acquireQzone(await policy(), runtime, root)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toHaveLength(1);
  });

  it('quarantines failed detail evidence and preserves previous completed runs', async () => {
    const first = await acquireQzone(await policy(), runtime, root);
    const originalManifest = await readFile(path.join(root, first.runId, 'run.json'), 'utf8');
    respond = (req, res) => {
      if (req.url?.startsWith(`${routeBase}feed?`)) json(res, { ok: true, data: { items: [post], cursor: '', has_more: false } });
      else json(res, { ok: true, data: { post: { ...post, id: '10001:DifferentTid' } } });
    };
    await expect(acquireQzone(await policy(), runtime, root)).rejects.toMatchObject({ code: 'invalid-response' });
    const directories = await readdir(root);
    expect(directories.filter((entry) => !entry.startsWith('.partial-'))).toEqual([first.runId]);
    expect(await readFile(path.join(root, first.runId, 'run.json'), 'utf8')).toBe(originalManifest);
    const partial = directories.find((entry) => entry.startsWith('.partial-'))!;
    expect(await readdir(path.join(root, partial))).not.toContain('run.json');
  });

  it('pauses on disconnected transport without logging the network error', async () => {
    respond = (req) => req.socket.destroy(new Error('excluded-network-secret'));
    await expect(new AstrBotQzoneClient(runtime, '10001').feed()).rejects.toMatchObject({ code: 'transport', message: 'QZone acquisition failed: transport' });
  });

  it('rejects non-private evidence roots before network acquisition', async () => {
    await chmod(root, 0o755);
    await expect(acquireQzone(await policy(), runtime, root)).rejects.toThrow('mode 0700');
    expect(requests).toHaveLength(0);
  });

  it.each(['equal', 'descendant', 'ancestor', 'normalized-descendant'])('rejects %s protected-root overlap before writes or requests', async (kind) => {
    const protectedRoot = path.join(root, 'platform-state');
    const output = kind === 'equal' ? protectedRoot : kind === 'ancestor' ? root :
      kind === 'normalized-descendant' ? `${root}/elsewhere/../platform-state/evidence` :
        path.join(protectedRoot, 'evidence');
    await expect(acquireQzone(await policy(), { ...runtime, protectedRoot }, output)).rejects.toThrow('protected platform storage');
    expect(requests).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('allows a nonoverlapping sibling with a shared string prefix without requiring the protected root to exist', async () => {
    const protectedRoot = path.join(root, 'platform-state');
    const output = path.join(root, 'platform-state-evidence');
    const result = await acquireQzone(await policy(), { ...runtime, protectedRoot }, output);
    expect(await readdir(root)).toEqual(['platform-state-evidence']);
    const manifest = JSON.parse(await readFile(path.join(output, result.runId, 'run.json'), 'utf8'));
    expect(manifest.discovery).toMatchObject({ listedCount: 1, detailCount: 1 });
    expect(JSON.stringify(manifest)).not.toContain(protectedRoot);
  });

  it.each(['root', 'ancestor'])('rejects a symlinked output %s without following it into protected storage', async (kind) => {
    const protectedRoot = path.join(root, 'platform-state');
    const alias = path.join(root, 'output-alias');
    // The nonexistent target remains untouched; following this link would create platform state.
    await symlink(protectedRoot, alias);
    const output = kind === 'root' ? alias : path.join(alias, 'evidence');
    await expect(acquireQzone(await policy(), { ...runtime, protectedRoot }, output)).rejects.toThrow('must not contain symlinks');
    expect(requests).toHaveLength(0);
    expect(await readdir(root)).toEqual(['output-alias']);
  });
});
