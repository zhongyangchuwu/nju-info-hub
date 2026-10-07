import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAbsoluteRuntime, type WereadAcquireRuntime } from './config.js';
import { normalizeWereadLatest } from './normalize.js';
import { parseWechatSourcePolicy } from './policy.js';
import { buildWereadShadowBundle } from './shadow.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rejectSymlinkPath(target: string): Promise<void> {
  let current = path.parse(target).root;
  for (const component of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Restricted path must not contain symlinks');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function restrictedOutputRoot(outputRoot: string, protectedRoot: string): Promise<string> {
  const resolved = path.resolve(outputRoot);
  const protectedResolved = path.resolve(protectedRoot);
  if (contains(repositoryRoot, resolved) || contains(protectedResolved, resolved) ||
      contains(resolved, repositoryRoot) || contains(resolved, protectedResolved)) {
    throw new Error('Restricted output must be separate from repository and provider state');
  }
  await rejectSymlinkPath(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (contains(repositoryRoot, canonical) || contains(protectedResolved, canonical) ||
      contains(canonical, repositoryRoot) || contains(canonical, protectedResolved)) {
    throw new Error('Restricted output resolves into repository or provider state');
  }
  const info = await stat(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Restricted output root must be operator-owned and mode 0700');
  }
  return canonical;
}

async function readIsolatedJson(inputPath: string, protectedRoot: string): Promise<{ bytes: Buffer; value: unknown }> {
  const resolved = path.resolve(inputPath);
  const protectedResolved = path.resolve(protectedRoot);
  if (contains(protectedResolved, resolved) || contains(repositoryRoot, resolved)) {
    throw new Error('Input JSON must not be read from provider state or repository');
  }
  await rejectSymlinkPath(resolved);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('Input JSON must be a regular file');
  const canonical = await realpath(resolved);
  if (contains(protectedResolved, canonical) || contains(repositoryRoot, canonical)) {
    throw new Error('Input JSON resolves into provider state or repository');
  }
  const bytes = await readFile(canonical);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Input must be valid JSON');
  }
  return { bytes, value };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function acquireWereadLatest(runtimeInput: WereadAcquireRuntime): Promise<{
  runId: string;
  shadowItemId: string;
  sourceItemId: string;
  bundleEligible: false;
  publicationEligible: false;
  shadowBundleCreated: boolean;
}> {
  const runtime = assertAbsoluteRuntime(runtimeInput);
  const root = await restrictedOutputRoot(runtime.outputRoot, runtime.protectedRoot);
  const providerExport = await readIsolatedJson(runtime.inputPath, runtime.protectedRoot);
  const candidate = normalizeWereadLatest(providerExport.value);

  const runId = randomUUID();
  const now = new Date();
  const startedAt = now.toISOString();
  const sourcePolicy = runtime.sourcePolicyPath === undefined ? null : parseWechatSourcePolicy(
    (await readIsolatedJson(runtime.sourcePolicyPath, runtime.protectedRoot)).value,
    now,
  );
  const shadow = sourcePolicy === null ? null : buildWereadShadowBundle(candidate, sourcePolicy, runId, now);
  const staging = await mkdtemp(path.join(root, '.partial-'));
  await mkdir(path.join(staging, 'blobs'), { mode: 0o700 });

  const rawSha256 = sha256(providerExport.bytes);
  await writeFile(path.join(staging, 'blobs', rawSha256), providerExport.bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(
    path.join(staging, 'candidate.json'),
    JSON.stringify(candidate, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );

  if (shadow !== null) {
    const publicSafe = path.join(staging, 'public-safe');
    await mkdir(publicSafe, { mode: 0o700 });
    await mkdir(path.join(publicSafe, 'blobs'), { mode: 0o700 });
    await writeFile(path.join(publicSafe, 'blobs', sha256(shadow.metadataBytes)), shadow.metadataBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(publicSafe, 'bundle.json'), JSON.stringify(shadow.bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Qualification evidence remains operator-only, outside the public-safe projection.
    await writeFile(path.join(staging, 'source-policy.json'), JSON.stringify(sourcePolicy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }

  const manifest = {
    schemaVersion: 2,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    evidenceTier: 'restricted',
    publicationEligible: false,
    bundleIdentityEligible: true,
    bundleEligible: false,
    shadowBundle: shadow === null ? null : {
      path: 'public-safe/bundle.json',
      decisionStatus: 'review-required',
      policyVersion: shadow.bundle.envelopes[0]!.decision.policyVersion,
    },
    identityStatus: 'complete',
    missingNativeIdentity: [],
    discovery: candidate.discovery,
    candidate: {
      shadowItemId: candidate.shadowItemId,
      sourceItemId: candidate.item.sourceItemId,
      providerFeedId: candidate.source.providerFeedId,
      providerReviewId: candidate.item.providerReviewId,
    },
    rawEvidence: {
      sha256: rawSha256,
      contentType: 'application/json; charset=utf-8',
      byteLength: providerExport.bytes.byteLength,
      evidenceKind: 'provider-export',
      sanitizationVersion: 'werss-weread-positive-export-v2',
    },
    provenance: candidate.provenance,
  };
  await writeFile(path.join(staging, 'run.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(staging, path.join(root, runId));

  return {
    runId,
    shadowItemId: candidate.shadowItemId,
    sourceItemId: candidate.item.sourceItemId,
    bundleEligible: false,
    publicationEligible: false,
    shadowBundleCreated: shadow !== null,
  };
}
