import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWereadLatest } from './acquire.js';
import { readVerifiedWereadAcquisition } from './acquisition-evidence.js';
import { normalizeWereadLatest } from './normalize.js';
import { offlinePaths, parseJsonBytes, privateBytes, privateDirectory, privateJson } from './storage.js';

const created: string[] = [];
const cutoff = new Date('2026-10-07T14:00:00.000Z');

async function setup(shadow = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nju-weread-evidence-'));
  created.push(base);
  const input = path.join(base, 'input');
  const outputRoot = path.join(base, 'acquisitions');
  const protectedRoot = path.join(base, 'provider-state');
  await mkdir(input, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const inputPath = path.join(input, 'latest.json');
  await writeFile(inputPath, await readFile(new URL('./fixtures/latest-export.json', import.meta.url)), { mode: 0o600 });
  const sourcePolicyPath = path.join(input, 'policy.json');
  if (shadow) {
    await writeFile(sourcePolicyPath, await readFile(new URL('./fixtures/source-policy.json', import.meta.url)), { mode: 0o600 });
  }
  const result = await acquireWereadLatest({ inputPath, outputRoot, protectedRoot, ...(shadow ? { sourcePolicyPath } : {}) });
  const runDir = path.join(outputRoot, result.runId);
  const manifestPath = path.join(runDir, 'run.json');
  const candidatePath = path.join(runDir, 'candidate.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  const rawPath = path.join(runDir, 'blobs', manifest.rawEvidence.sha256);
  const observationRoot = path.join(base, 'observations');
  return { base, inputPath, protectedRoot, observationRoot, runDir, manifestPath, candidatePath, rawPath, manifestBytes, manifest, candidate };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T13:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readVerifiedWereadAcquisition', () => {
  it.each([false, true])('verifies a real restricted acquisition (shadow=%s) without mutation', async (shadow) => {
    const run = await setup(shadow);
    const before = await readdir(run.runDir);
    const result = await readVerifiedWereadAcquisition(run.runDir, cutoff);
    expect(result).toEqual({
      inputDir: run.runDir,
      runId: run.manifest.runId,
      manifestSha256: createHash('sha256').update(run.manifestBytes).digest('hex'),
      publisherIdentity: run.candidate.source.publisherIdentity,
      startedAt: run.manifest.startedAt,
      completedAt: run.manifest.completedAt,
      acquiredAt: run.candidate.provenance.acquiredAt,
      sourceItemId: run.candidate.item.sourceItemId,
      nativeIdentity: run.candidate.item.nativeIdentity,
      publicationTime: run.candidate.item.publicationTime,
      contentSha256: run.candidate.item.content.sha256,
    });
    expect(result).not.toHaveProperty('providerReviewId');
    expect(result).not.toHaveProperty('shadowItemId');
    expect(result).not.toHaveProperty('body');
    expect(await readFile(run.manifestPath)).toEqual(run.manifestBytes);
    expect(await readdir(run.runDir)).toEqual(before);
  });

  it('does not read source policy or public-safe artifacts as progress evidence', async () => {
    const run = await setup(true);
    await rm(path.join(run.runDir, 'public-safe'), { recursive: true });
    await rm(path.join(run.runDir, 'source-policy.json'));
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).resolves.toMatchObject({ runId: run.manifest.runId });
  });

  it('compares candidate semantics rather than JSON key order and binds exact manifest bytes', async () => {
    const run = await setup();
    const reordered = {
      ...run.candidate,
      source: Object.fromEntries(Object.entries(run.candidate.source).reverse()),
      item: Object.fromEntries(Object.entries(run.candidate.item).reverse()),
    };
    await writeFile(run.candidatePath, JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse())), { mode: 0o600 });
    const manifestBytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(run.manifest).reverse())));
    await writeFile(run.manifestPath, manifestBytes, { mode: 0o600 });
    const result = await readVerifiedWereadAcquisition(run.runDir, cutoff);
    expect(result.manifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    expect(result.manifestSha256).not.toBe(createHash('sha256').update(run.manifestBytes).digest('hex'));
  });

  it.each([
    'extra-root', 'extra-provenance', 'extra-raw', 'extra-candidate', 'extra-discovery', 'schema-version',
    'publication-eligible', 'bundle-eligible', 'bundle-identity', 'evidence-tier', 'identity-incomplete',
    'missing-native', 'discovery-complete', 'shadow-path', 'shadow-decision', 'shadow-extra', 'shadow-policy',
    'raw-mime', 'raw-length', 'raw-sha', 'raw-kind', 'raw-sanitization',
    'source-item', 'shadow-item', 'provider-feed', 'provider-review', 'provenance-provider', 'provenance-acquired',
    'missing-completed', 'bad-started', 'future-completed', 'reversed-clocks', 'started-before-acquired',
  ])('rejects altered manifest %s', async (kind) => {
    const run = await setup();
    const manifest = run.manifest;
    switch (kind) {
      case 'extra-root': manifest.cookie = 'not-allowed'; break;
      case 'extra-provenance': manifest.provenance.extra = true; break;
      case 'extra-raw': manifest.rawEvidence.extra = true; break;
      case 'extra-candidate': manifest.candidate.extra = true; break;
      case 'extra-discovery': manifest.discovery.extra = true; break;
      case 'schema-version': manifest.schemaVersion = 1; break;
      case 'publication-eligible': manifest.publicationEligible = true; break;
      case 'bundle-eligible': manifest.bundleEligible = true; break;
      case 'bundle-identity': manifest.bundleIdentityEligible = false; break;
      case 'evidence-tier': manifest.evidenceTier = 'public-safe'; break;
      case 'identity-incomplete': manifest.identityStatus = 'incomplete'; break;
      case 'missing-native': manifest.missingNativeIdentity = ['mid']; break;
      case 'discovery-complete': manifest.discovery.complete = true; break;
      case 'shadow-path': manifest.shadowBundle = { path: '../bundle.json', decisionStatus: 'review-required', policyVersion: 'v1' }; break;
      case 'shadow-decision': manifest.shadowBundle = { path: 'public-safe/bundle.json', decisionStatus: 'approved', policyVersion: 'v1' }; break;
      case 'shadow-extra': manifest.shadowBundle = { path: 'public-safe/bundle.json', decisionStatus: 'review-required', policyVersion: 'v1', extra: true }; break;
      case 'shadow-policy': manifest.shadowBundle = { path: 'public-safe/bundle.json', decisionStatus: 'review-required', policyVersion: '' }; break;
      case 'raw-mime': manifest.rawEvidence.contentType = 'text/html'; break;
      case 'raw-length': manifest.rawEvidence.byteLength++; break;
      case 'raw-sha': manifest.rawEvidence.sha256 = '0'.repeat(64); break;
      case 'raw-kind': manifest.rawEvidence.evidenceKind = 'public-safe'; break;
      case 'raw-sanitization': manifest.rawEvidence.sanitizationVersion = 'none'; break;
      case 'source-item': manifest.candidate.sourceItemId = 'foreign-source-item'; break;
      case 'shadow-item': manifest.candidate.shadowItemId = `wechat-weread-review-v1:${'0'.repeat(64)}`; break;
      case 'provider-feed': manifest.candidate.providerFeedId = 'MP_WXS_123'; break;
      case 'provider-review': manifest.candidate.providerReviewId = 'foreign-review'; break;
      case 'provenance-provider': manifest.provenance.provider.version = 'tampered'; break;
      case 'provenance-acquired': manifest.provenance.acquiredAt = '2026-10-07T12:49:00Z'; break;
      case 'missing-completed': delete manifest.completedAt; break;
      case 'bad-started': manifest.startedAt = '2026-10-07T13:00:00'; break;
      case 'future-completed': manifest.completedAt = '2026-10-07T14:00:01Z'; break;
      case 'reversed-clocks': manifest.completedAt = '2026-10-07T12:59:59Z'; break;
      case 'started-before-acquired': manifest.startedAt = '2026-10-07T12:00:00Z'; break;
      default: throw new Error(`Unhandled fixture mutation: ${kind}`);
    }
    await writeFile(run.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).rejects.toThrow();
  });

  it.each(['source', 'native', 'source-item', 'content', 'eligibility', 'qualification', 'provenance', 'extra'])('rejects altered candidate %s', async (kind) => {
    const run = await setup();
    const candidate = run.candidate;
    if (kind === 'source') candidate.source.publisherIdentity.value = 'OTg3NjU0MzIxMA==';
    else if (kind === 'native') candidate.item.nativeIdentity.mid = '10002';
    else if (kind === 'source-item') candidate.item.sourceItemId = 'foreign-item';
    else if (kind === 'content') candidate.item.content.sha256 = '0'.repeat(64);
    else if (kind === 'eligibility') candidate.publicationEligible = true;
    else if (kind === 'qualification') candidate.identityQualification.publisher.status = 'unverified';
    else if (kind === 'provenance') candidate.provenance.provider.version = 'tampered';
    else candidate.extra = true;
    await writeFile(run.candidatePath, JSON.stringify(candidate), { mode: 0o600 });
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).rejects.toThrow(/candidate/);
  });

  it('rejects a changed original export even if it remains valid JSON', async () => {
    const run = await setup();
    await writeFile(run.rawPath, Buffer.concat([await readFile(run.rawPath), Buffer.from(' ')]));
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).rejects.toThrow(/descriptor/);
  });

  it.each(['content', 'identity', 'future-acquired', 'future-publication'])('reconstructs stored original export and rejects rebound %s', async (kind) => {
    const run = await setup();
    const raw = JSON.parse(await readFile(run.rawPath, 'utf8'));
    if (kind === 'content') raw.latest.contentHtml = '<p>changed body</p>';
    else if (kind === 'identity') raw.latest.canonicalBiz = 'OTg3NjU0MzIxMA==';
    else if (kind === 'future-acquired') raw.acquiredAt = '2026-10-07T13:00:01Z';
    else raw.latest.publicationUnixSeconds = String(Math.floor(cutoff.getTime() / 1000));
    const bytes = Buffer.from(JSON.stringify(raw));
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(run.runDir, 'blobs', hash), bytes, { mode: 0o600 });
    run.manifest.rawEvidence.sha256 = hash;
    run.manifest.rawEvidence.byteLength = bytes.byteLength;
    if (kind.startsWith('future')) {
      const candidate = normalizeWereadLatest(raw);
      await writeFile(run.candidatePath, JSON.stringify(candidate), { mode: 0o600 });
      run.manifest.provenance = candidate.provenance;
    }
    await writeFile(run.manifestPath, JSON.stringify(run.manifest), { mode: 0o600 });
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).rejects.toThrow();
  });

  it.each(['partial', 'foreign-uuid', 'uppercase-uuid', 'missing-manifest', 'missing-candidate', 'missing-raw', 'malformed-json', 'invalid-cutoff'])('rejects incomplete or malformed run %s', async (kind) => {
    const run = await setup();
    let directory = run.runDir;
    if (kind === 'partial' || kind === 'foreign-uuid' || kind === 'uppercase-uuid') {
      directory = path.join(path.dirname(directory), kind === 'partial' ? '.partial-abc' : kind === 'foreign-uuid' ? randomUUID() : run.manifest.runId.toUpperCase());
      await rename(run.runDir, directory);
    } else if (kind === 'missing-manifest') {
      await rm(run.manifestPath);
      await writeFile(path.join(run.runDir, 'complete.json'), '{}', { mode: 0o600 });
    } else if (kind === 'missing-candidate') await rm(run.candidatePath);
    else if (kind === 'missing-raw') await rm(run.rawPath);
    else if (kind === 'malformed-json') await writeFile(run.manifestPath, '{', { mode: 0o600 });
    await expect(readVerifiedWereadAcquisition(directory, kind === 'invalid-cutoff' ? new Date(NaN) : cutoff)).rejects.toThrow();
  });

  it('accepts clock equality at the cutoff', async () => {
    const run = await setup();
    await expect(readVerifiedWereadAcquisition(run.runDir, new Date(run.manifest.completedAt))).resolves.toMatchObject({ runId: run.manifest.runId });
  });

  it.each(['acquired', 'started', 'completed'])('rejects submillisecond %s clock inversions', async (kind) => {
    const run = await setup();
    if (kind === 'acquired') {
      const raw = JSON.parse(await readFile(run.rawPath, 'utf8'));
      raw.acquiredAt = '2026-10-07T13:00:00.0001Z';
      const bytes = Buffer.from(JSON.stringify(raw));
      const hash = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path.join(run.runDir, 'blobs', hash), bytes, { mode: 0o600 });
      const candidate = normalizeWereadLatest(raw);
      await writeFile(run.candidatePath, JSON.stringify(candidate), { mode: 0o600 });
      run.manifest.rawEvidence.sha256 = hash;
      run.manifest.rawEvidence.byteLength = bytes.byteLength;
      run.manifest.provenance = candidate.provenance;
    } else if (kind === 'started') run.manifest.startedAt = '2026-10-07T13:00:00.0001Z';
    else run.manifest.completedAt = '2026-10-07T14:00:00.0001Z';
    await writeFile(run.manifestPath, JSON.stringify(run.manifest), { mode: 0o600 });
    await expect(readVerifiedWereadAcquisition(run.runDir, cutoff)).rejects.toThrow();
  });
});

describe('offline storage namespaces and private reads', () => {
  it('validates separate private namespaces without inspecting the declared protected root', async () => {
    const run = await setup();
    const protectedAlias = path.join(run.base, 'uninspected-provider-root');
    await symlink(path.join(run.base, 'nonexistent-private-target'), protectedAlias);
    await expect(offlinePaths([run.runDir], [run.inputPath], run.observationRoot, protectedAlias)).resolves.toEqual({
      inputDirs: [run.runDir], inputFiles: [run.inputPath], outputRoot: run.observationRoot, protectedRoot: protectedAlias,
    });
    expect(await readdir(run.base)).not.toContain('observations');
  });

  it.each(['protected-dir', 'protected-file', 'protected-output', 'repository-dir', 'repository-output', 'overlap-output', 'overlap-input', 'repeat', 'alias', 'relative', 'control', 'partial'])('rejects declared %s before inspecting earlier missing inputs', async (kind) => {
    const run = await setup();
    let directories = [path.join(run.base, 'missing-run')];
    let files: string[] = [];
    let output = run.observationRoot;
    const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
    if (kind === 'protected-dir') directories.push(path.join(run.protectedRoot, randomUUID()));
    else if (kind === 'protected-file') files = [path.join(run.protectedRoot, 'secret.json')];
    else if (kind === 'protected-output') output = path.join(run.protectedRoot, 'output');
    else if (kind === 'repository-dir') directories.push(path.join(repository, 'run'));
    else if (kind === 'repository-output') output = path.join(repository, 'output');
    else if (kind === 'overlap-output') output = path.join(directories[0]!, 'output');
    else if (kind === 'overlap-input') files = [path.join(directories[0]!, 'run.json')];
    else if (kind === 'repeat') directories.push(directories[0]!);
    else if (kind === 'alias') directories.push(`${run.runDir}/../${path.basename(run.runDir)}`);
    else if (kind === 'relative') directories.push('relative-run');
    else if (kind === 'control') files = [path.join(run.base, 'bad\nfile')];
    else directories = [path.join(run.base, '.partial-abc')];
    await expect(offlinePaths(directories, files, output, run.protectedRoot)).rejects.toThrow(/boundary|separate|overlap|canonical|Incomplete/);
  });

  it('rejects noncanonical protected namespaces without resolving them', async () => {
    const run = await setup();
    await expect(offlinePaths([run.runDir], [], run.observationRoot, `${run.protectedRoot}/..`)).rejects.toThrow(/canonical/);
  });

  it.each(['run-symlink', 'ancestor-symlink', 'file-symlink', 'run-mode', 'file-mode', 'blobs-mode', 'hardlink', 'oversized', 'fifo', 'directory-file'])('rejects unsafe private evidence %s', async (kind) => {
    const run = await setup();
    let directory = run.runDir;
    if (kind === 'run-symlink') {
      const alias = path.join(run.base, randomUUID());
      await symlink(directory, alias);
      directory = alias;
    } else if (kind === 'ancestor-symlink') {
      const alias = path.join(run.base, 'acquisition-alias');
      await symlink(path.dirname(directory), alias);
      directory = path.join(alias, path.basename(directory));
    } else if (kind === 'file-symlink') {
      const stored = path.join(run.base, 'stored-run.json');
      await rename(run.manifestPath, stored);
      await symlink(stored, run.manifestPath);
    } else if (kind === 'run-mode') await chmod(directory, 0o755);
    else if (kind === 'file-mode') await chmod(run.manifestPath, 0o644);
    else if (kind === 'blobs-mode') await chmod(path.join(directory, 'blobs'), 0o755);
    else if (kind === 'hardlink') await link(run.manifestPath, path.join(run.base, 'manifest-alias'));
    else if (kind === 'oversized') await writeFile(run.manifestPath, Buffer.alloc(2 * 1024 * 1024 + 1));
    else if (kind === 'fifo') {
      await rm(run.manifestPath);
      await promisify(execFile)('mkfifo', ['-m', '600', run.manifestPath]);
    } else {
      await rm(run.manifestPath);
      await mkdir(run.manifestPath, { mode: 0o700 });
    }
    await expect(readVerifiedWereadAcquisition(directory, cutoff)).rejects.toThrow(/Unsafe/);
  });

  it('refuses unsafe declaration files and directories without reading their content', async () => {
    const run = await setup();
    await chmod(run.inputPath, 0o644);
    await expect(offlinePaths([run.runDir], [run.inputPath], run.observationRoot, run.protectedRoot)).rejects.toThrow(/Unsafe private/);
    await chmod(run.inputPath, 0o600);
    await chmod(path.dirname(run.inputPath), 0o755);
    await expect(privateDirectory(path.dirname(run.inputPath))).rejects.toThrow(/Unsafe private/);
  });

  it('bounds ordinary private reads at two MiB and refuses devices', async () => {
    const run = await setup();
    const maximum = Buffer.alloc(2 * 1024 * 1024, 0x20);
    await writeFile(run.inputPath, maximum, { mode: 0o600 });
    const bytes = await privateBytes(run.inputPath);
    expect(bytes.byteLength).toBe(maximum.byteLength);
    expect(bytes.equals(maximum)).toBe(true);
    await writeFile(run.inputPath, Buffer.alloc(maximum.byteLength + 1), { mode: 0o600 });
    await expect(privateBytes(run.inputPath)).rejects.toThrow(/Unsafe private/);
    await expect(privateBytes('/dev/null')).rejects.toThrow(/Unsafe private/);
  });

  it('rejects invalid UTF-8 instead of silently replacing bytes', async () => {
    const run = await setup();
    const invalid = Buffer.from([0x22, 0xff, 0x22]);
    await writeFile(run.inputPath, invalid, { mode: 0o600 });
    expect(await privateBytes(run.inputPath)).toEqual(invalid);
    expect(() => parseJsonBytes(invalid)).toThrow();
    await expect(privateJson(run.inputPath)).rejects.toThrow();
  });
});
