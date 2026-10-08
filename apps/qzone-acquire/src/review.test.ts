import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSocialAcquisitionBundle, socialPublicationBinding } from '@nju-info/core';
import { parseQzonePolicy, type QzonePolicy } from './config.js';
import { normalizeQzonePost, type QzonePost } from './normalize.js';
import { qzoneMetadataBytes, type QzoneReviewDecisions, type QzoneReviewRequest } from './review-model.js';
import { createQzoneShadow, reviewQzoneShadow, type QzoneShadowOptions } from './review.js';

const mime = 'application/json; charset=utf-8';

async function writeJson(filename: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await writeFile(filename, bytes, { mode: 0o600 });
}

async function readJson<T>(filename: string): Promise<T> {
  const bytes = await readFile(filename, 'utf8');
  return JSON.parse(bytes) as T;
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await snapshot(filename);
      for (const [name, bytes] of Object.entries(children)) result[`${entry.name}/${name}`] = bytes;
    } else result[entry.name] = (await readFile(filename)).toString('base64');
  }
  return result;
}

async function expectPrivate(directory: string): Promise<void> {
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await expectPrivate(filename);
    else expect((await stat(filename)).mode & 0o777).toBe(0o600);
  }
}

async function storeEvidence(directory: string, value: unknown, sourceUrl: string, acquiredAt: string) {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(directory, 'blobs', sha256), bytes, { mode: 0o600 });
  return {
    blob: { sha256, contentType: mime, byteLength: bytes.length }, sourceUrl, acquiredAt,
    evidenceTier: 'restricted' as const, evidenceKind: 'provider-export' as const,
    sanitizationVersion: 'qzone-positive-extraction-v1',
  };
}

interface SyntheticManifest {
  schemaVersion: number;
  runId: string;
  startedAt: string;
  completedAt: string;
  evidenceTier: string;
  publicationEligible: boolean;
  policy: QzonePolicy;
  provenance: {
    method: string;
    provider: { name: string; version: string };
    plugin: { name: string; version: string };
    exporter: { name: string; version: string };
  };
  discovery: { complete: boolean; reason: string; requestedLimit: number; listedCount: number; detailCount: number };
  feedEvidence: SyntheticEvidence;
}

interface SyntheticEvidence {
  blob: { sha256: string; contentType: string; byteLength: number };
  sourceUrl: string;
  acquiredAt: string;
  evidenceTier: 'restricted';
  evidenceKind: 'provider-export';
  sanitizationVersion: string;
}

interface SyntheticCandidate {
  sourceItemId: string;
  rawEvidence: SyntheticEvidence;
  content: { text: string; html: string; completeness: string };
}

interface OfflineManifest {
  kind: string;
  itemCount: number;
  bundleSha256: string;
  publicationEligible: boolean;
  bundleEligible: boolean;
  counts: { approved: number; rejected: number; reviewRequired: number };
  discovery: { complete: boolean; reason: string };
}

describe('isolated offline QZone filesystem review', () => {
  let root: string;
  let options: QzoneShadowOptions;
  let policy: QzonePolicy;
  let manifest: SyntheticManifest;
  let posts: QzonePost[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'qzone-offline-test-'));
    const runId = randomUUID();
    const inputDir = path.join(root, 'acquisitions', runId);
    await mkdir(path.join(inputDir, 'blobs'), { recursive: true, mode: 0o700 });
    policy = parseQzonePolicy(JSON.parse(await readFile(new URL('./fixtures/policy.json', import.meta.url), 'utf8')));
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const acquiredAt = new Date(Date.now() - 8_000).toISOString();
    posts = ['CaseSensitiveTid', 'SecondTid', 'ThirdTid'].map((tid) => ({
      uin: '10001', tid, created_at: 1791331200,
      content: 'excluded-provider-body-and-operator-state',
      mediaUrls: ['http://photo.store.qq.com/synthetic-image'],
    }));
    const candidates = [];
    for (const post of posts) {
      const candidate = normalizeQzonePost(post);
      const rawEvidence = await storeEvidence(inputDir, post, candidate.originalUrl, acquiredAt);
      candidates.push({ ...candidate, rawEvidence });
    }
    // Feed text can be truncated; only native identity must agree with detail.
    const feed = posts.map((post) => ({ ...post, content: 'truncated' }));
    manifest = {
      schemaVersion: 1, runId, startedAt, completedAt: new Date(Date.now() - 5_000).toISOString(),
      evidenceTier: 'restricted', publicationEligible: false, policy,
      provenance: {
        method: 'credentialed-public-export', provider: { name: 'AstrBot', version: 'synthetic-provider' },
        plugin: { name: 'astrbot_plugin_qzone', version: 'synthetic-plugin' },
        exporter: { name: '@nju-info/qzone-acquire', version: '0.0.0' },
      },
      discovery: { complete: false, reason: 'provider-first-page-only', requestedLimit: 10, listedCount: 3, detailCount: 3 },
      feedEvidence: await storeEvidence(inputDir, feed, 'https://user.qzone.qq.com/10001', acquiredAt),
    };
    await writeJson(path.join(inputDir, 'run.json'), manifest);
    await writeJson(path.join(inputDir, 'candidates.json'), candidates);
    options = {
      inputDir, selectionPath: path.join(root, 'selection.json'), policyPath: path.join(root, 'policy.json'),
      outputRoot: path.join(root, 'shadows'), protectedRoot: path.join(root, 'never-created-platform-state'),
    };
    await writeJson(options.policyPath, policy);
    await writeJson(options.selectionPath, {
      schemaVersion: 1,
      items: [candidates[2]!, candidates[0]!, candidates[1]!].map((candidate, index) => ({
        sourceItemId: candidate.sourceItemId, title: index === 0 ? null : `Operator title ${index}`,
      })),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function shadowAndDecisions() {
    const result = await createQzoneShadow(options);
    const inputDir = path.join(options.outputRoot, result.runId);
    const request = await readJson<QzoneReviewRequest>(path.join(inputDir, 'review-request.json'));
    const decisions: QzoneReviewDecisions = {
      schemaVersion: 1, bundleId: request.bundleId, policySha256: request.policySha256,
      reviewer: 'excluded-private-reviewer', reviewedAt: new Date().toISOString(),
      items: request.items.map((item, index) => ({
        ...item, status: (['approved', 'rejected', 'review-required'] as const)[index]!, reason: `excluded-private-reason-${index}`,
      })),
    };
    const decisionsPath = path.join(root, 'decisions.json');
    await writeJson(decisionsPath, decisions);
    return {
      result, inputDir, request, decisions,
      reviewOptions: { inputDir, decisionsPath, policyPath: options.policyPath, outputRoot: path.join(root, 'reviews'), protectedRoot: options.protectedRoot },
    };
  }

  it('completes sanitized shadow and approved/rejected/pending declarations with immutable private inputs', async () => {
    const acquisitionBefore = await snapshot(options.inputDir);
    const { result, inputDir, decisions, reviewOptions } = await shadowAndDecisions();
    expect(result).toMatchObject({ itemCount: 3, approved: 0, rejected: 0, reviewRequired: 3, publicationEligible: false, bundleEligible: false });
    expect(await readdir(options.outputRoot)).toEqual([result.runId]);
    const shadowBefore = await snapshot(inputDir);
    const shadowBundle = parseSocialAcquisitionBundle(await readJson(path.join(inputDir, 'public-safe', 'bundle.json')));
    expect(shadowBundle.envelopes.map((envelope) => envelope.payload.item.nativeIdentity)).toEqual([
      { scheme: 'qzone-tid', version: 1, tid: 'ThirdTid' },
      { scheme: 'qzone-tid', version: 1, tid: 'CaseSensitiveTid' },
      { scheme: 'qzone-tid', version: 1, tid: 'SecondTid' },
    ]);
    expect(shadowBundle.envelopes[0]!.payload.content.title).toBeNull();
    const reviewed = await reviewQzoneShadow(reviewOptions);
    expect(reviewed).toMatchObject({ itemCount: 3, approved: 1, rejected: 1, reviewRequired: 1, publicationEligible: false, bundleEligible: false });
    expect(await readdir(reviewOptions.outputRoot)).toEqual([reviewed.runId]);
    const directory = path.join(reviewOptions.outputRoot, reviewed.runId);
    const bundle = parseSocialAcquisitionBundle(await readJson(path.join(directory, 'public-safe', 'bundle.json')));
    expect(bundle.envelopes.map((envelope) => envelope.payload)).toEqual(shadowBundle.envelopes.map((envelope) => envelope.payload));
    expect(bundle.envelopes.map((envelope) => envelope.decision.status)).toEqual(['approved', 'rejected', 'review-required']);
    expect(bundle.envelopes.map((envelope) => envelope.decision.mode)).toEqual(['link-only', 'none', 'none']);
    const publicFiles = await snapshot(path.join(directory, 'public-safe'));
    const publicText = Object.values(publicFiles).map((value) => Buffer.from(value, 'base64').toString()).join('\n');
    for (const excluded of ['excluded-private-reviewer', 'excluded-private-reason', 'excluded-provider-body', 'photo.store.qq.com', 'Synthetic operator', 'Individual rights review required']) {
      expect(publicText).not.toContain(excluded);
    }
    for (const envelope of bundle.envelopes) {
      const reference = envelope.payload.rawBlobs[0]!;
      expect(await readFile(path.join(directory, 'public-safe', 'blobs', reference.blob.sha256))).toEqual(qzoneMetadataBytes(envelope.payload));
    }
    expect(await readJson(path.join(directory, 'item-review.json'))).toEqual(decisions);
    expect(await readJson(path.join(directory, 'run.json'))).toMatchObject({
      kind: 'qzone-review', publicationEligible: false, bundleEligible: false,
      counts: { approved: 1, rejected: 1, reviewRequired: 1 }, discovery: { complete: false, reason: 'provider-first-page-only' },
    });
    await expectPrivate(inputDir);
    await expectPrivate(directory);
    expect(await snapshot(options.inputDir)).toEqual(acquisitionBefore);
    expect(await snapshot(inputDir)).toEqual(shadowBefore);
    expect(await readdir(root)).not.toContain('never-created-platform-state');
  });

  it.each(['candidate', 'detail-bytes', 'detail-projection', 'feed-bytes', 'feed-identity', 'feed-extra', 'descriptor-length', 'descriptor-mime', 'counts', 'unknown-key', 'future-completion', 'run-identity'])(
    'rejects forged acquisition %s before output creation', async (kind) => {
      const candidates = await readJson<SyntheticCandidate[]>(path.join(options.inputDir, 'candidates.json'));
      if (kind === 'candidate') candidates[0]!.content.text = 'forged-private-candidate';
      if (kind === 'detail-bytes') await writeFile(path.join(options.inputDir, 'blobs', candidates[0]!.rawEvidence.blob.sha256), '{}');
      if (kind === 'detail-projection') {
        candidates[0]!.rawEvidence = await storeEvidence(options.inputDir, { ...posts[0]!, content: 'forged-detail' }, candidates[0]!.rawEvidence.sourceUrl, candidates[0]!.rawEvidence.acquiredAt);
      }
      if (kind === 'feed-bytes') await writeFile(path.join(options.inputDir, 'blobs', manifest.feedEvidence.blob.sha256), '[]');
      if (kind === 'feed-identity' || kind === 'feed-extra') {
        const feed = posts.map((post, index) => index !== 0 ? post : kind === 'feed-identity'
          ? { ...post, tid: 'ForeignTid' } : { ...post, viewer: 'excluded-private-viewer' });
        manifest.feedEvidence = await storeEvidence(options.inputDir, feed, manifest.feedEvidence.sourceUrl, manifest.feedEvidence.acquiredAt);
      }
      if (kind === 'descriptor-length') candidates[0]!.rawEvidence.blob.byteLength++;
      if (kind === 'descriptor-mime') candidates[0]!.rawEvidence.blob.contentType = 'text/plain';
      if (kind === 'counts') manifest.discovery.detailCount = 2;
      if (kind === 'future-completion') manifest.completedAt = '9999-01-01T00:00:00Z';
      if (kind === 'run-identity') manifest.runId = randomUUID();
      await writeJson(path.join(options.inputDir, 'candidates.json'), candidates);
      await writeJson(path.join(options.inputDir, 'run.json'), kind === 'unknown-key' ? { ...manifest, session: 'excluded-private-session' } : manifest);
      await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
      expect(await readdir(root)).not.toContain('shadows');
    },
  );

  it.each(['missing', 'partial'])('rejects %s completion evidence', async (kind) => {
    if (kind === 'missing') await rm(path.join(options.inputDir, 'run.json'));
    else {
      const partial = path.join(path.dirname(options.inputDir), '.partial-synthetic');
      await rename(options.inputDir, partial);
      options.inputDir = partial;
    }
    await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
    expect(await readdir(root)).not.toContain('shadows');
  });

  it.each(['input-dir', 'input-file', 'blob', 'output-root', 'output-ancestor', 'input-ancestor'])(
    'rejects symlinked %s without accessing protected targets', async (kind) => {
      if (kind === 'input-dir') {
        const alias = path.join(root, 'input-alias');
        await symlink(options.inputDir, alias);
        options.inputDir = alias;
      } else if (kind === 'input-file') {
        await rm(options.selectionPath);
        await symlink(options.protectedRoot, options.selectionPath);
      } else if (kind === 'blob') {
        const candidates = await readJson<SyntheticCandidate[]>(path.join(options.inputDir, 'candidates.json'));
        const blob = path.join(options.inputDir, 'blobs', candidates[0]!.rawEvidence.blob.sha256);
        await rm(blob);
        await symlink(options.protectedRoot, blob);
      } else if (kind === 'input-ancestor') {
        const alias = path.join(root, 'ancestor-alias');
        await symlink(path.dirname(options.inputDir), alias);
        options.inputDir = path.join(alias, manifest.runId);
      } else {
        await symlink(options.protectedRoot, options.outputRoot);
        if (kind === 'output-ancestor') options.outputRoot = path.join(options.outputRoot, 'child');
      }
      await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
      expect(await readdir(root)).not.toContain('never-created-platform-state');
    },
  );

  it.each(['directory-mode', 'file-mode', 'directory-as-file', 'oversized-file', 'blob-directory-mode', 'output-mode'])(
    'rejects non-private or non-regular %s inputs', async (kind) => {
      if (kind === 'directory-mode') await chmod(options.inputDir, 0o755);
      if (kind === 'file-mode') await chmod(options.selectionPath, 0o644);
      if (kind === 'directory-as-file') {
        await rm(options.selectionPath);
        await mkdir(options.selectionPath, { mode: 0o700 });
      }
      if (kind === 'oversized-file') await writeFile(options.selectionPath, Buffer.alloc(2 * 1024 * 1024 + 1));
      if (kind === 'blob-directory-mode') await chmod(path.join(options.inputDir, 'blobs'), 0o755);
      if (kind === 'output-mode') await mkdir(options.outputRoot, { mode: 0o755 });
      await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
      if (kind === 'output-mode') expect(await readdir(options.outputRoot)).toEqual([]);
      else expect(await readdir(root)).not.toContain('shadows');
    },
  );

  it.each(['input-protected', 'file-protected', 'output-protected', 'output-protected-ancestor', 'output-repository', 'input-repository', 'output-input', 'output-input-child', 'output-input-parent', 'relative'])(
    'rejects %s boundaries before writes', async (kind) => {
      if (kind === 'input-protected') options.inputDir = path.join(options.protectedRoot, manifest.runId);
      if (kind === 'file-protected') options.policyPath = path.join(options.protectedRoot, 'policy.json');
      if (kind === 'output-protected') options.outputRoot = path.join(options.protectedRoot, 'output');
      if (kind === 'output-protected-ancestor') options.outputRoot = root;
      if (kind === 'output-repository') options.outputRoot = path.resolve(import.meta.dirname, '..', 'offline-forbidden-output');
      if (kind === 'input-repository') options.inputDir = import.meta.dirname;
      if (kind === 'output-input') options.outputRoot = options.inputDir;
      if (kind === 'output-input-child') options.outputRoot = path.join(options.inputDir, 'child');
      if (kind === 'output-input-parent') options.outputRoot = path.dirname(options.inputDir);
      if (kind === 'relative') options.selectionPath = 'relative-selection.json';
      await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
      expect(await readdir(root)).not.toContain('never-created-platform-state');
      expect(await readdir(root)).not.toContain('shadows');
    },
  );

  it('permits policy version refresh at shadow creation but never stale review approval', async () => {
    const current = { ...policy, source: { ...policy.source, policyVersion: 'synthetic-policy-v2' } };
    await writeJson(options.policyPath, current);
    const { inputDir, reviewOptions } = await shadowAndDecisions();
    const bundle = parseSocialAcquisitionBundle(await readJson(path.join(inputDir, 'public-safe', 'bundle.json')));
    expect(bundle.envelopes.every((envelope) => envelope.payload.source.policyVersion === 'synthetic-policy-v2')).toBe(true);
    await writeJson(options.policyPath, { ...current, qualification: { ...current.qualification, redistributionBasis: 'changed-private-evidence' } });
    await expect(reviewQzoneShadow(reviewOptions)).rejects.toThrow('QZone offline review failed');
    expect(await readdir(root)).not.toContain('reviews');
  });

  it('evaluates historical qualification at acquisition start rather than the offline clock', async () => {
    manifest.policy = { ...policy, qualification: { ...policy.qualification, reviewUntil: new Date(Date.parse(manifest.startedAt) + 2_000).toISOString() } };
    await writeJson(path.join(options.inputDir, 'run.json'), manifest);
    expect(await createQzoneShadow(options)).toMatchObject({ itemCount: 3, reviewRequired: 3 });
  });

  it.each(['source-id', 'publisher', 'expired', 'future-review'])(
    'rejects changed identity or invalid current policy %s', async (kind) => {
      const changed = structuredClone(policy);
      if (kind === 'source-id') changed.source.sourceId = 'foreign-source';
      if (kind === 'publisher') changed.source.publisherIdentity.value = '20002';
      if (kind === 'expired') changed.qualification.reviewUntil = '2026-01-02T00:00:00Z';
      if (kind === 'future-review') changed.qualification.reviewedAt = '9998-01-01T00:00:00Z';
      await writeJson(options.policyPath, changed);
      await expect(createQzoneShadow(options)).rejects.toThrow('QZone offline shadow failed');
      expect(await readdir(root)).not.toContain('shadows');
    },
  );

  it.each(['blob', 'metadata-content', 'bundle-hash', 'bundle-count', 'snapshot', 'old-binding', 'request-time', 'decision-coverage', 'already-reviewed', 'expired-policy'])(
    'rejects changed shadow or decision %s before output creation and preserves earlier runs', async (kind) => {
      const { inputDir, request, decisions, reviewOptions } = await shadowAndDecisions();
      const previous = await reviewQzoneShadow(reviewOptions);
      const previousDir = path.join(reviewOptions.outputRoot, previous.runId);
      const previousBytes = await snapshot(previousDir);
      if (kind === 'blob') {
        const bundle = parseSocialAcquisitionBundle(await readJson(path.join(inputDir, 'public-safe', 'bundle.json')));
        await writeFile(path.join(inputDir, 'public-safe', 'blobs', bundle.envelopes[0]!.payload.rawBlobs[0]!.blob.sha256), '{}');
      }
      if (kind === 'metadata-content') {
        const filename = path.join(inputDir, 'public-safe', 'bundle.json');
        const bundle = parseSocialAcquisitionBundle(await readJson(filename));
        const envelope = bundle.envelopes[0]!;
        const expected = JSON.parse(qzoneMetadataBytes(envelope.payload).toString('utf8')) as Record<string, unknown>;
        const forged = Buffer.from(JSON.stringify({ ...expected, viewer: 'excluded-private-viewer' }) + '\n');
        const hash = createHash('sha256').update(forged).digest('hex');
        envelope.payload.rawBlobs[0]!.blob = { sha256: hash, byteLength: forged.length, contentType: mime };
        envelope.decision.binding = socialPublicationBinding(envelope.payload);
        request.items[0]!.binding = envelope.decision.binding;
        decisions.items[0]!.binding = envelope.decision.binding;
        await writeFile(path.join(inputDir, 'public-safe', 'blobs', hash), forged, { mode: 0o600 });
        await writeJson(filename, bundle);
        const run = await readJson<OfflineManifest>(path.join(inputDir, 'run.json'));
        run.bundleSha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
        await writeJson(path.join(inputDir, 'run.json'), run);
        await writeJson(path.join(inputDir, 'review-request.json'), request);
        await writeJson(reviewOptions.decisionsPath, decisions);
      }
      if (kind === 'expired-policy') await writeJson(options.policyPath, {
        ...policy, qualification: { ...policy.qualification, reviewUntil: '2026-01-02T00:00:00Z' },
      });
      if (kind === 'bundle-hash' || kind === 'bundle-count') {
        const run = await readJson<OfflineManifest>(path.join(inputDir, 'run.json'));
        if (kind === 'bundle-hash') run.bundleSha256 = '0'.repeat(64);
        else run.itemCount = 2;
        await writeJson(path.join(inputDir, 'run.json'), run);
      }
      if (kind === 'snapshot') await writeJson(path.join(inputDir, 'source-policy.json'), { ...policy, qualification: { ...policy.qualification, owner: 'changed-private-owner' } });
      if (kind === 'old-binding') {
        decisions.items[0]!.binding = { payloadSha256: '0'.repeat(64), mediaSha256s: [] };
        await writeJson(reviewOptions.decisionsPath, decisions);
      }
      if (kind === 'request-time') await writeJson(path.join(inputDir, 'review-request.json'), { ...request, preparedAt: '2026-01-01T00:00:00Z' });
      if (kind === 'decision-coverage') {
        decisions.items.pop();
        await writeJson(reviewOptions.decisionsPath, decisions);
      }
      if (kind === 'already-reviewed') reviewOptions.inputDir = previousDir;
      const shadowBytes = await snapshot(inputDir);
      await expect(reviewQzoneShadow(reviewOptions)).rejects.toThrow('QZone offline review failed');
      expect(await readdir(reviewOptions.outputRoot)).toEqual([previous.runId]);
      expect(await snapshot(previousDir)).toEqual(previousBytes);
      expect(await snapshot(inputDir)).toEqual(shadowBytes);
    },
  );
});
