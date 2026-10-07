import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AstrBotQzoneClient } from './client.js';
import { parseQzonePolicy, type QzonePolicy, type QzoneRuntimeConfig } from './config.js';
import { normalizeQzonePost } from './normalize.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function restrictedRoot(outputRoot: string, protectedRoot: string): Promise<string> {
  if (!path.isAbsolute(outputRoot)) throw new Error('Restricted output root must be absolute');
  const resolved = path.resolve(outputRoot);
  if (contains(repositoryRoot, resolved) || contains(protectedRoot, resolved) ||
      contains(resolved, repositoryRoot) || contains(resolved, protectedRoot)) {
    throw new Error('Restricted output must be separate from the repository and protected platform storage');
  }
  // Inspect only output ancestors, never the declared protected root or symlink targets.
  // Refuse aliases before mkdir so an output symlink cannot write into platform state.
  let current = path.parse(resolved).root;
  for (const component of path.relative(current, resolved).split(path.sep)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('Restricted output path must not contain symlinks');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (contains(repositoryRoot, canonical) || contains(protectedRoot, canonical) ||
      contains(canonical, repositoryRoot) || contains(canonical, protectedRoot)) {
    throw new Error('Restricted output must not resolve to repository or protected platform storage');
  }
  const info = await stat(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Restricted output root must be operator-owned and mode 0700');
  }
  return canonical;
}

export async function acquireQzone(
  inputPolicy: QzonePolicy,
  runtime: QzoneRuntimeConfig,
  outputRoot: string,
): Promise<{ runId: string; itemCount: number; discoveryComplete: false }> {
  const policy = parseQzonePolicy(inputPolicy);
  const uin = policy.source.publisherIdentity.value;
  const client = new AstrBotQzoneClient(runtime, uin);
  const root = await restrictedRoot(outputRoot, path.resolve(runtime.protectedRoot));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const staging = await mkdtemp(path.join(root, '.partial-'));
  await mkdir(path.join(staging, 'blobs'), { mode: 0o700 });
  const storedHashes = new Set<string>();

  async function storeEvidence(value: unknown, sourceUrl: string, acquiredAt: string) {
    // Hash the stored positive extraction, never claim lossless origin-response bytes.
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!storedHashes.has(sha256)) {
      await writeFile(path.join(staging, 'blobs', sha256), bytes, { flag: 'wx', mode: 0o600 });
      storedHashes.add(sha256);
    }
    return {
      blob: { sha256, contentType: 'application/json; charset=utf-8', byteLength: bytes.byteLength },
      sourceUrl, acquiredAt, evidenceTier: 'restricted', evidenceKind: 'provider-export',
      sanitizationVersion: 'qzone-positive-extraction-v1',
    };
  }

  const feed = await client.feed();
  const feedEvidence = await storeEvidence(feed.data, `https://user.qzone.qq.com/${uin}`, feed.acquiredAt);
  const candidates = [];
  for (const listed of feed.data) {
    const detail = await client.detail(listed);
    const originalUrl = `https://user.qzone.qq.com/${uin}/mood/${encodeURIComponent(detail.data.tid)}`;
    const rawEvidence = await storeEvidence(detail.data, originalUrl, detail.acquiredAt);
    // Raw selected fields are immutable on disk before canonical normalization.
    candidates.push({ ...normalizeQzonePost(detail.data), rawEvidence });
  }
  await writeFile(path.join(staging, 'candidates.json'), JSON.stringify(candidates, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const manifest = {
    schemaVersion: 1, runId, startedAt, completedAt: new Date().toISOString(),
    evidenceTier: 'restricted', publicationEligible: false, policy,
    provenance: {
      method: 'credentialed-public-export',
      provider: { name: 'AstrBot', version: runtime.astrbotVersion },
      plugin: { name: 'astrbot_plugin_qzone', version: runtime.pluginVersion },
      exporter: { name: '@nju-info/qzone-acquire', version: '0.0.0' },
    },
    discovery: {
      complete: false, reason: 'provider-first-page-only', requestedLimit: 10,
      listedCount: feed.data.length, detailCount: candidates.length,
    },
    feedEvidence,
  };
  await writeFile(path.join(staging, 'run.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Readers accept only final run-ID directories. Failed runs remain restricted .partial-* evidence.
  await rename(staging, path.join(root, runId));
  return { runId, itemCount: candidates.length, discoveryComplete: false };
}
