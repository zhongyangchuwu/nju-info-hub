import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditQzoneSource, type QzoneAuditOptions } from './audit.js';
import type { QzoneAuditLedger, QzoneManualAudit, QzoneObservations } from './audit-model.js';
import { parseQzonePolicy, type QzonePolicy } from './config.js';
import { normalizeQzonePost, type QzoneCandidate, type QzonePost } from './normalize.js';
import { qzonePolicySha256 } from './review-model.js';
import { offlinePaths } from './storage.js';

const mime = 'application/json; charset=utf-8';
const startedAt = '2026-10-01T09:00:00.000Z';
const acquiredAt = '2026-10-01T09:00:01.000Z';
const completedAt = '2026-10-01T09:00:02.000Z';

interface SyntheticEvidence {
  blob: { sha256: string; contentType: string; byteLength: number };
  sourceUrl: string;
  acquiredAt: string;
  evidenceTier: 'restricted';
  evidenceKind: 'provider-export';
  sanitizationVersion: string;
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

interface SyntheticRun {
  inputDir: string;
  manifest: SyntheticManifest;
  candidates: Array<QzoneCandidate & { rawEvidence: SyntheticEvidence }>;
  posts: QzonePost[];
}

interface AuditManifest {
  schemaVersion: number;
  kind: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  publicationEligible: boolean;
  bundleEligible: boolean;
  benchmarkStarted: boolean;
  sourcePolicySha256: string;
  source: QzoneAuditLedger['source'];
  discovery: { complete: boolean; reason: string };
  files: Array<{ filename: string; sha256: string; byteLength: number; contentType: string }>;
  successfulRuns: Array<{ runId: string; manifestSha256: string }>;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, 'utf8')) as T;
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await snapshot(filename))) result[`${entry.name}/${name}`] = bytes;
    } else result[entry.name] = (await readFile(filename)).toString('base64');
  }
  return result;
}

async function storeEvidence(directory: string, value: unknown, sourceUrl: string, time: string): Promise<SyntheticEvidence> {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(directory, 'blobs', sha256), bytes, { mode: 0o600 });
  return {
    blob: { sha256, contentType: mime, byteLength: bytes.length }, sourceUrl, acquiredAt: time,
    evidenceTier: 'restricted', evidenceKind: 'provider-export', sanitizationVersion: 'qzone-positive-extraction-v1',
  };
}

function syntheticPost(tid: string): QzonePost {
  return {
    uin: '10001', tid, created_at: Date.parse('2026-10-01T08:00:00Z') / 1000,
    content: 'excluded-provider-body-and-session-marker', mediaUrls: ['http://photo.store.qq.com/excluded-media-marker'],
  };
}

// Fixtures are independently authored declarations; production never derives the audit from runs.
describe('isolated offline QZone manual audit filesystem pipeline', () => {
  let root: string;
  let options: QzoneAuditOptions;
  let policy: QzonePolicy;
  let audit: QzoneManualAudit;
  let observations: QzoneObservations;
  let run: SyntheticRun;

  async function acquisition(tids: string[], start = startedAt, acquired = acquiredAt, end = completedAt): Promise<SyntheticRun> {
    const runId = randomUUID();
    const inputDir = path.join(root, 'acquisitions', runId);
    await mkdir(path.join(inputDir, 'blobs'), { recursive: true, mode: 0o700 });
    const posts = tids.map(syntheticPost);
    const candidates = [];
    for (const post of posts) {
      const candidate = normalizeQzonePost(post);
      candidates.push({ ...candidate, rawEvidence: await storeEvidence(inputDir, post, candidate.originalUrl, acquired) });
    }
    const manifest: SyntheticManifest = {
      schemaVersion: 1, runId, startedAt: start, completedAt: end, evidenceTier: 'restricted', publicationEligible: false, policy,
      provenance: {
        method: 'credentialed-public-export', provider: { name: 'AstrBot', version: 'synthetic-provider' },
        plugin: { name: 'astrbot_plugin_qzone', version: 'synthetic-plugin' },
        exporter: { name: '@nju-info/qzone-acquire', version: '0.0.0' },
      },
      discovery: { complete: false, reason: 'provider-first-page-only', requestedLimit: 10, listedCount: posts.length, detailCount: posts.length },
      feedEvidence: await storeEvidence(inputDir, posts.map((post) => ({ ...post, content: 'truncated preview' })),
        'https://user.qzone.qq.com/10001', acquired),
    };
    await writeJson(path.join(inputDir, 'run.json'), manifest);
    await writeJson(path.join(inputDir, 'candidates.json'), candidates);
    return { inputDir, manifest, candidates, posts };
  }

  async function declarations(): Promise<void> {
    await writeJson(options.auditPath, audit);
    await writeJson(options.observationsPath, observations);
    await writeJson(options.policyPath, policy);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'qzone-audit-test-'));
    policy = parseQzonePolicy(JSON.parse(await readFile(new URL('./fixtures/policy.json', import.meta.url), 'utf8')));
    options = {
      auditPath: path.join(root, 'manual.json'), observationsPath: path.join(root, 'observations.json'),
      policyPath: path.join(root, 'policy.json'), outputRoot: path.join(root, 'audits'),
      protectedRoot: path.join(root, 'never-created-platform-state'),
    };
    audit = {
      schemaVersion: 1, sourceId: policy.source.sourceId, publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '10001' },
      window: { startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-02T00:00:00Z' },
      observedAt: '2026-10-02T01:00:00Z', method: 'manual-public-profile', auditor: 'excluded-private-auditor',
      publicAudienceEvidence: 'excluded-private-audience', coverage: { status: 'complete', reason: 'excluded-private-coverage' },
      items: ['CapturedCaseTid', 'MissedCaseTid'].map((tid) => ({
        nativeIdentity: { scheme: 'qzone-tid', version: 1, tid },
        publicationTime: normalizeQzonePost(syntheticPost(tid)).publicationTime, actionable: 'yes',
      })),
    };
    run = await acquisition(['CapturedCaseTid']);
    observations = {
      schemaVersion: 1, sourceId: policy.source.sourceId, publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '10001' },
      captureCutoffAt: '2026-10-02T12:00:00Z', attempts: [
        { outcome: 'success', attemptedAt: startedAt, runDirectory: run.inputDir },
        { outcome: 'failed', attemptedAt: '2026-10-01T10:00:00Z', failureCode: 'authentication' },
      ],
    };
    await declarations();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectNoOutput(): Promise<void> {
    expect(await readdir(root)).not.toContain('audits');
    expect(await readdir(root)).not.toContain('never-created-platform-state');
  }

  it('writes exact immutable private snapshots, hashes, incomplete discovery and explicit ineligibility', async () => {
    const inputBefore = await snapshot(run.inputDir);
    const declarationBefore = await Promise.all([options.auditPath, options.observationsPath, options.policyPath].map((file) => readFile(file)));
    const result = await auditQzoneSource(options);
    expect(result).toMatchObject({
      counts: { auditedItems: 2, knownInWindow: 2, capturedKnown: 1, missingKnown: 1, capturedPartial: 1 },
      rates: { postIdentityCapture: { numerator: 1, denominator: 2, ratio: 0.5 }, actionablePostCapture: { ratio: 0.5 } },
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false,
    });
    expect(Object.keys(result).sort()).toEqual(['benchmarkStarted', 'bundleEligible', 'counts', 'publicationEligible', 'rates', 'runId']);
    expect(await readdir(options.outputRoot)).toEqual([result.runId]);
    const directory = path.join(options.outputRoot, result.runId);
    expect((await readdir(directory)).sort()).toEqual(['ledger.json', 'manual-audit.json', 'observations.json', 'run.json', 'source-policy.json']);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const manifest = await readJson<AuditManifest>(path.join(directory, 'run.json'));
    expect(manifest).toMatchObject({
      schemaVersion: 1, kind: 'qzone-audit', runId: result.runId,
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false,
      sourcePolicySha256: qzonePolicySha256(policy), discovery: { complete: false, reason: 'provider-first-page-only' },
    });
    expect(Date.parse(manifest.startedAt)).toBeLessThanOrEqual(Date.parse(manifest.completedAt));
    expect(manifest.files.map((file) => file.filename)).toEqual(['manual-audit.json', 'observations.json', 'source-policy.json', 'ledger.json']);
    for (const descriptor of manifest.files) {
      const bytes = await readFile(path.join(directory, descriptor.filename));
      expect(descriptor).toEqual({ filename: descriptor.filename, contentType: mime, byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
      expect((await stat(path.join(directory, descriptor.filename))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(path.join(directory, 'run.json'))).mode & 0o777).toBe(0o600);
    expect(manifest.successfulRuns).toEqual([{ runId: run.manifest.runId,
      manifestSha256: createHash('sha256').update(await readFile(path.join(run.inputDir, 'run.json'))).digest('hex') }]);
    expect(await readJson(path.join(directory, 'manual-audit.json'))).toEqual(audit);
    expect(await readJson(path.join(directory, 'observations.json'))).toEqual(observations);
    expect(await readJson(path.join(directory, 'source-policy.json'))).toEqual(policy);
    const ledger = await readJson<QzoneAuditLedger>(path.join(directory, 'ledger.json'));
    expect(ledger.source).toEqual(manifest.source);
    expect(ledger.observations).toMatchObject({ declaredAttemptCount: 2, verifiedSuccessCount: 1, declaredFailureCount: 1,
      incompleteSuccessCount: 1, failureCounts: { authentication: 1, 'rate-limited': 0, provider: 0, transport: 0, 'invalid-response': 0 } });
    const itemText = JSON.stringify({ items: ledger.items, unauditedItems: ledger.unauditedItems, successfulRuns: ledger.observations.successfulRuns });
    const safeText = JSON.stringify(result);
    for (const excluded of ['excluded-provider-body', 'excluded-media-marker', run.inputDir, 'rawEvidence', 'blobs', 'sourceUrl', 'originalUrl']) {
      expect(itemText).not.toContain(excluded);
      expect(safeText).not.toContain(excluded);
    }
    for (const excluded of ['excluded-private-auditor', 'excluded-private-audience', 'excluded-private-coverage', '10001', 'CapturedCaseTid', root]) {
      expect(safeText).not.toContain(excluded);
    }
    const stored = Object.values(await snapshot(directory)).map((bytes) => Buffer.from(bytes, 'base64').toString()).join('\n');
    expect(stored).not.toContain('excluded-provider-body');
    expect(stored).not.toContain('excluded-media-marker');
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(await snapshot(run.inputDir)).toEqual(inputBefore);
    expect(await Promise.all([options.auditPath, options.observationsPath, options.policyPath].map((file) => readFile(file)))).toEqual(declarationBefore);
    expect(await readdir(root)).not.toContain('never-created-platform-state');
    const previous = await snapshot(directory);
    const next = await auditQzoneSource(options);
    expect(next.runId).not.toBe(result.runId);
    expect(await snapshot(directory)).toEqual(previous);
  });

  it('deduplicates identities across independently declared successful runs and retains earliest detail observation', async () => {
    const second = await acquisition(['CapturedCaseTid', 'MissedCaseTid'], '2026-10-01T11:00:00.000Z', '2026-10-01T11:00:01.000Z', '2026-10-01T11:00:02.000Z');
    observations.attempts.unshift({ outcome: 'success', attemptedAt: second.manifest.startedAt, runDirectory: second.inputDir });
    await declarations();
    const result = await auditQzoneSource(options);
    expect(result.counts).toMatchObject({ capturedKnown: 2, missingKnown: 0, capturedPartial: 2 });
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
    const ledger = await readJson<QzoneAuditLedger>(path.join(options.outputRoot, result.runId, 'ledger.json'));
    const captured = ledger.items.find((item) => item.nativeIdentity.scheme === 'qzone-tid' && item.nativeIdentity.tid === 'CapturedCaseTid')!;
    expect(captured.firstSeenAt).toBe(acquiredAt);
    expect(captured.sourceRunIds.sort()).toEqual([run.manifest.runId, second.manifest.runId].sort());
    expect(ledger.observations).toMatchObject({ verifiedSuccessCount: 2, incompleteSuccessCount: 2,
      lastSuccessAt: second.manifest.completedAt, lastNewItemObservedAt: '2026-10-01T11:00:01.000Z' });
  });

  it.each(['failure-only', 'empty-success', 'no-attempts'])('supports %s without inventing success or a nonempty denominator', async (kind) => {
    audit.items = [];
    if (kind === 'empty-success') {
      const empty = await acquisition([]);
      observations.attempts = [{ outcome: 'success', attemptedAt: startedAt, runDirectory: empty.inputDir }];
    } else observations.attempts = kind === 'failure-only'
      ? [{ outcome: 'failed', attemptedAt: startedAt, failureCode: 'transport' }] : [];
    await declarations();
    const result = await auditQzoneSource(options);
    expect(result.counts).toMatchObject({ auditedItems: 0, capturedKnown: 0, missingKnown: 0 });
    expect(result.rates.postIdentityCapture).toMatchObject({ numerator: 0, denominator: 0, ratio: null,
      unavailableReasonCodes: ['zero-denominator'] });
    const ledger = await readJson<QzoneAuditLedger>(path.join(options.outputRoot, result.runId, 'ledger.json'));
    expect(ledger.observations.verifiedSuccessCount).toBe(kind === 'empty-success' ? 1 : 0);
    expect(ledger.observations.declaredFailureCount).toBe(kind === 'failure-only' ? 1 : 0);
  });

  it.each(['candidate', 'detail-bytes', 'detail-projection', 'feed-bytes', 'feed-identity', 'feed-extra', 'descriptor-length', 'descriptor-mime', 'counts', 'unknown-key', 'future-completion', 'run-identity', 'feed-clock', 'detail-clock', 'source', 'publisher'])('rejects forged acquisition %s before creating output', async (kind) => {
    if (kind === 'candidate') run.candidates[0]!.content.text = 'forged-private-candidate';
    if (kind === 'detail-bytes') await writeFile(path.join(run.inputDir, 'blobs', run.candidates[0]!.rawEvidence.blob.sha256), '{}');
    if (kind === 'detail-projection') run.candidates[0]!.rawEvidence = await storeEvidence(run.inputDir,
      { ...run.posts[0]!, content: 'forged detail' }, run.candidates[0]!.originalUrl, acquiredAt);
    if (kind === 'feed-bytes') await writeFile(path.join(run.inputDir, 'blobs', run.manifest.feedEvidence.blob.sha256), '[]');
    if (kind === 'feed-identity' || kind === 'feed-extra') run.manifest.feedEvidence = await storeEvidence(run.inputDir,
      [{ ...run.posts[0]!, ...(kind === 'feed-identity' ? { tid: 'ForeignTid' } : { viewer: 'excluded-viewer' }) }],
      run.manifest.feedEvidence.sourceUrl, acquiredAt);
    if (kind === 'descriptor-length') run.candidates[0]!.rawEvidence.blob.byteLength++;
    if (kind === 'descriptor-mime') run.candidates[0]!.rawEvidence.blob.contentType = 'text/plain';
    if (kind === 'counts') run.manifest.discovery.detailCount = 0;
    if (kind === 'future-completion') run.manifest.completedAt = '9999-01-01T00:00:00Z';
    if (kind === 'run-identity') run.manifest.runId = randomUUID();
    if (kind === 'feed-clock') run.manifest.feedEvidence.acquiredAt = '2026-10-01T08:59:59Z';
    if (kind === 'detail-clock') run.candidates[0]!.rawEvidence.acquiredAt = '2026-10-01T09:00:03Z';
    if (kind === 'source') run.manifest.policy = { ...policy, source: { ...policy.source, sourceId: 'foreign-source' } };
    if (kind === 'publisher') run.manifest.policy = { ...policy, source: { ...policy.source, publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '20002' } } };
    await writeJson(path.join(run.inputDir, 'candidates.json'), run.candidates);
    await writeJson(path.join(run.inputDir, 'run.json'), kind === 'unknown-key' ? { ...run.manifest, session: 'private-forged-session' } : run.manifest);
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    await expectNoOutput();
  });

  it.each(['missing', 'partial', 'cutoff', 'attempt-clock', 'audit-source', 'observations-publisher', 'expired-policy'])('rejects invalid declaration/completion %s without counting an empty success', async (kind) => {
    if (kind === 'missing') await rm(path.join(run.inputDir, 'run.json'));
    if (kind === 'partial') {
      const partial = path.join(path.dirname(run.inputDir), '.partial-synthetic');
      await rename(run.inputDir, partial);
      observations.attempts = [{ outcome: 'success', attemptedAt: startedAt, runDirectory: partial }];
    }
    if (kind === 'cutoff') {
      // Structurally valid declarations, but actual completed success is later than cutoff.
      audit.window.endAt = '2026-10-01T09:00:01Z';
      observations.captureCutoffAt = '2026-10-01T09:00:01Z';
      observations.attempts = [{ outcome: 'success', attemptedAt: startedAt, runDirectory: run.inputDir }];
    }
    if (kind === 'attempt-clock') observations.attempts = [{ outcome: 'success', attemptedAt: acquiredAt, runDirectory: run.inputDir }];
    if (kind === 'audit-source') audit.sourceId = 'foreign-source';
    if (kind === 'observations-publisher') observations.publisherIdentity = { scheme: 'qzone-uin', version: 1, value: '20002' };
    if (kind === 'expired-policy') policy.qualification.reviewUntil = '2026-01-02T00:00:00Z';
    await declarations();
    const before = await snapshot(root);
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    expect(await snapshot(root)).toEqual(before);
    await expectNoOutput();
  });

  it('allows a renewed current policy while binding its complete private qualification fingerprint', async () => {
    policy = { ...policy, source: { ...policy.source, policyVersion: 'renewed-policy-v2' },
      qualification: { ...policy.qualification, owner: 'changed-private-owner' } };
    await declarations();
    const result = await auditQzoneSource(options);
    const manifest = await readJson<AuditManifest>(path.join(options.outputRoot, result.runId, 'run.json'));
    expect(manifest.sourcePolicySha256).toBe(qzonePolicySha256(policy));
    expect(manifest.source.policyVersion).toBe('renewed-policy-v2');
  });

  it.each(['run', 'file', 'blob', 'output', 'output-ancestor', 'run-ancestor'])('rejects symlinked %s without touching targets', async (kind) => {
    if (kind === 'run' || kind === 'run-ancestor') {
      const alias = path.join(root, 'input-alias');
      await symlink(kind === 'run' ? run.inputDir : path.dirname(run.inputDir), alias);
      observations.attempts = [{ outcome: 'success', attemptedAt: startedAt,
        runDirectory: kind === 'run' ? alias : path.join(alias, run.manifest.runId) }];
      await declarations();
    } else if (kind === 'file') {
      await rm(options.auditPath);
      await symlink(options.protectedRoot, options.auditPath);
    } else if (kind === 'blob') {
      const blob = path.join(run.inputDir, 'blobs', run.candidates[0]!.rawEvidence.blob.sha256);
      await rm(blob);
      await symlink(options.protectedRoot, blob);
    } else {
      await symlink(options.protectedRoot, options.outputRoot);
      if (kind === 'output-ancestor') options.outputRoot = path.join(options.outputRoot, 'child');
    }
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    expect(await readdir(root)).not.toContain('never-created-platform-state');
  });

  it.each(['run-mode', 'file-mode', 'parent-mode', 'directory-as-file', 'oversized-file', 'blob-mode', 'output-mode'])('rejects unsafe private/regular storage %s', async (kind) => {
    if (kind === 'run-mode') await chmod(run.inputDir, 0o755);
    if (kind === 'file-mode') await chmod(options.auditPath, 0o644);
    if (kind === 'parent-mode') await chmod(root, 0o755);
    if (kind === 'directory-as-file') { await rm(options.auditPath); await mkdir(options.auditPath, { mode: 0o700 }); }
    if (kind === 'oversized-file') await writeFile(options.auditPath, Buffer.alloc(2 * 1024 * 1024 + 1));
    if (kind === 'blob-mode') await chmod(path.join(run.inputDir, 'blobs'), 0o755);
    if (kind === 'output-mode') await mkdir(options.outputRoot, { mode: 0o755 });
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    if (kind === 'output-mode') expect(await readdir(options.outputRoot)).toEqual([]);
    else await expectNoOutput();
  });

  it.each(['protected-file', 'protected-output', 'repository-file', 'repository-output', 'run-output', 'run-child-output', 'run-parent-output', 'input-file-output', 'relative', 'noncanonical-protected'])('rejects lexical %s boundaries before output writes', async (kind) => {
    if (kind === 'protected-file') options.auditPath = path.join(options.protectedRoot, 'audit.json');
    if (kind === 'protected-output') options.outputRoot = path.join(options.protectedRoot, 'audits');
    if (kind === 'repository-file') options.policyPath = path.join(import.meta.dirname, 'fixtures', 'policy.json');
    if (kind === 'repository-output') options.outputRoot = path.resolve(import.meta.dirname, '..', 'forbidden-output');
    if (kind === 'run-output') options.outputRoot = run.inputDir;
    if (kind === 'run-child-output') options.outputRoot = path.join(run.inputDir, 'child');
    if (kind === 'run-parent-output') options.outputRoot = path.dirname(run.inputDir);
    if (kind === 'input-file-output') options.outputRoot = options.auditPath;
    if (kind === 'relative') options.auditPath = 'relative-audit.json';
    if (kind === 'noncanonical-protected') options.protectedRoot += '/..';
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    await expectNoOutput();
  });

  it('lexically excludes every success path together before inspecting earlier nonexistent directories', async () => {
    observations.attempts = [
      { outcome: 'success', attemptedAt: startedAt, runDirectory: path.join(root, 'nonexistent-run') },
      { outcome: 'success', attemptedAt: acquiredAt, runDirectory: path.join(options.protectedRoot, randomUUID()) },
    ];
    await declarations();
    await expect(offlinePaths(observations.attempts.flatMap((attempt) => attempt.outcome === 'success' ? [attempt.runDirectory] : []),
      [options.auditPath, options.observationsPath, options.policyPath], options.outputRoot, options.protectedRoot))
      .rejects.toThrow('Unsafe offline storage boundary');
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    await expectNoOutput();
  });

  it('bounds serialized snapshots before output creation even when compact input is under 2 MiB', async () => {
    observations.attempts = [];
    audit.items = Array.from({ length: 1000 }, (_, index) => ({ ...audit.items[0]!,
      nativeIdentity: { scheme: 'qzone-tid', version: 1, tid: `Synthetic${index}` } }));
    audit.coverage.reason = '';
    const baseLength = Buffer.byteLength(JSON.stringify(audit));
    audit.coverage.reason = 'x'.repeat(2 * 1024 * 1024 - baseLength - 1024);
    const inputBytes = Buffer.from(JSON.stringify(audit));
    expect(inputBytes.length).toBeLessThan(2 * 1024 * 1024);
    await writeFile(options.auditPath, inputBytes, { mode: 0o600 });
    await writeJson(options.observationsPath, observations);
    await expect(auditQzoneSource(options)).rejects.toThrow('QZone offline audit failed');
    await expectNoOutput();
  });

  it.each(['incomplete-audit', 'unknown-actionable', 'unlisted-acquisition'])('preserves explicit rate uncertainty for %s', async (kind) => {
    if (kind === 'incomplete-audit') audit.coverage.status = 'incomplete';
    if (kind === 'unknown-actionable') audit.items[0]!.actionable = 'unknown';
    if (kind === 'unlisted-acquisition') {
      const extra = await acquisition(['UnlistedNativeTid']);
      observations.attempts.push({ outcome: 'success', attemptedAt: startedAt, runDirectory: extra.inputDir });
    }
    await declarations();
    const result = await auditQzoneSource(options);
    expect(result.counts).toMatchObject({ knownInWindow: 2, capturedKnown: 1, missingKnown: 1 });
    if (kind === 'unknown-actionable') {
      expect(result.rates.postIdentityCapture.ratio).toBe(0.5);
      expect(result.rates.actionablePostCapture).toEqual({ numerator: null, denominator: null, ratio: null,
        unavailableReasonCodes: ['actionable-labels-unresolved'] });
    } else {
      expect(result.rates.postIdentityCapture).toEqual({ numerator: null, denominator: null, ratio: null,
        unavailableReasonCodes: [kind === 'incomplete-audit' ? 'audit-declared-incomplete' : 'unlisted-acquired-posts'] });
      expect(result.rates.actionablePostCapture.ratio).toBeNull();
    }
  });

  it('includes a verified late capture after window end but before the declared capture cutoff', async () => {
    const late = await acquisition(['MissedCaseTid'], '2026-10-02T10:00:00.000Z',
      '2026-10-02T10:00:01.000Z', '2026-10-02T10:00:02.000Z');
    observations.attempts.push({ outcome: 'success', attemptedAt: late.manifest.startedAt, runDirectory: late.inputDir });
    await declarations();
    const result = await auditQzoneSource(options);
    expect(result.counts).toMatchObject({ capturedKnown: 2, missingKnown: 0, capturedPartial: 2 });
    expect(result.rates.postIdentityCapture.ratio).toBe(1);
    const ledger = await readJson<QzoneAuditLedger>(path.join(options.outputRoot, result.runId, 'ledger.json'));
    expect(ledger.items[1]!.firstSeenAt).toBe('2026-10-02T10:00:01.000Z');
    expect(ledger.items[1]!.acquisitionLagMs).toBe(Date.parse('2026-10-02T10:00:01Z') - Date.parse('2026-10-01T08:00:00Z'));
  });

  it('redacts malformed/private errors and does not change previous completed runs on rejection', async () => {
    const first = await auditQzoneSource(options);
    const previousDir = path.join(options.outputRoot, first.runId);
    const before = await snapshot(previousDir);
    await writeFile(options.auditPath, '{"excluded-private-user-and-path":');
    await expect(auditQzoneSource(options)).rejects.toThrow(/^QZone offline audit failed$/);
    expect(await readdir(options.outputRoot)).toEqual([first.runId]);
    expect(await snapshot(previousDir)).toEqual(before);
  });
});
