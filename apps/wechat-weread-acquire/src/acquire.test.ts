import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSocialAcquisitionBundle, socialPublicationBinding } from '@nju-info/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWereadLatest } from './acquire.js';

const created: string[] = [];

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nju-wechat-weread-'));
  created.push(base);
  const inputDir = path.join(base, 'input');
  const outputRoot = path.join(base, 'output');
  const protectedRoot = path.join(base, 'provider-state');
  await mkdir(inputDir, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  await mkdir(protectedRoot, { mode: 0o700 });
  await chmod(outputRoot, 0o700);
  const inputPath = path.join(inputDir, 'latest.json');
  const fixturePath = new URL('./fixtures/latest-export.json', import.meta.url);
  await writeFile(inputPath, await readFile(fixturePath), { mode: 0o600 });
  return { inputPath, outputRoot, protectedRoot };
}

async function setupShadow() {
  const runtime = await setup();
  const sourcePolicyPath = path.join(path.dirname(runtime.inputPath), 'policy.json');
  await writeFile(sourcePolicyPath, await readFile(new URL('./fixtures/source-policy.json', import.meta.url)), { mode: 0o600 });
  return { ...runtime, sourcePolicyPath };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T13:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('acquireWereadLatest', () => {
  it('writes restricted evidence and an explicitly ineligible candidate', async () => {
    const runtime = await setup();
    const result = await acquireWereadLatest(runtime);
    expect(result.bundleEligible).toBe(false);
    expect(result.publicationEligible).toBe(false);
    expect(result.shadowBundleCreated).toBe(false);
    expect(await readdir(path.join(runtime.outputRoot, result.runId))).not.toContain('public-safe');

    const run = JSON.parse(await readFile(path.join(runtime.outputRoot, result.runId, 'run.json'), 'utf8'));
    const candidate = JSON.parse(await readFile(path.join(runtime.outputRoot, result.runId, 'candidate.json'), 'utf8'));
    expect(run.evidenceTier).toBe('restricted');
    expect(run.publicationEligible).toBe(false);
    expect(run.bundleIdentityEligible).toBe(true);
    expect(run.bundleEligible).toBe(false);
    expect(run.identityStatus).toBe('complete');
    expect(run.missingNativeIdentity).toEqual([]);
    expect(run.rawEvidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.rawEvidence.sanitizationVersion).toBe('werss-weread-positive-export-v2');
    expect(candidate.shadowItemId).toBe(result.shadowItemId);
    expect(candidate.item.sourceItemId).toBe(result.sourceItemId);
    expect(candidate.source.publisherIdentity.scheme).toBe('wechat-biz');
    expect(candidate.item.nativeIdentity.scheme).toBe('wechat-mid-idx');
    expect(candidate.item.content).not.toHaveProperty('html');
  });

  it('persists only sanitized metadata in a separate operator-only shadow bundle', async () => {
    const runtime = await setupShadow();
    const input = JSON.parse(await readFile(runtime.inputPath, 'utf8'));
    input.latest.contentHtml = '<p>restricted-body-canary</p>';
    await writeFile(runtime.inputPath, JSON.stringify(input), { mode: 0o600 });
    const providerBytes = await readFile(runtime.inputPath);
    const result = await acquireWereadLatest(runtime);
    expect(result).toMatchObject({ bundleEligible: false, publicationEligible: false, shadowBundleCreated: true });
    const runRoot = path.join(runtime.outputRoot, result.runId);
    const publicSafe = path.join(runRoot, 'public-safe');
    const bundleText = await readFile(path.join(publicSafe, 'bundle.json'), 'utf8');
    const bundle = parseSocialAcquisitionBundle(JSON.parse(bundleText));
    const envelope = bundle.envelopes[0]!;
    expect(envelope.decision).toMatchObject({
      status: 'review-required', mode: 'none', method: 'item-review',
      policyVersion: 'synthetic-review-v1', binding: socialPublicationBinding(envelope.payload),
    });
    const reference = envelope.payload.rawBlobs[0]!;
    const metadata = await readFile(path.join(publicSafe, 'blobs', reference.blob.sha256));
    expect(createHash('sha256').update(metadata).digest('hex')).toBe(reference.blob.sha256);
    expect(metadata.byteLength).toBe(reference.blob.byteLength);
    expect(metadata).not.toEqual(providerBytes);
    expect(JSON.parse(metadata.toString('utf8')).content).toEqual({
      title: 'Synthetic campus service notice', text: '', html: '', completeness: 'link-only',
    });
    const manifest = JSON.parse(await readFile(path.join(runRoot, 'run.json'), 'utf8'));
    const candidate = JSON.parse(await readFile(path.join(runRoot, 'candidate.json'), 'utf8'));
    expect(await readFile(path.join(runRoot, 'blobs', manifest.rawEvidence.sha256))).toEqual(providerBytes);
    expect(await readdir(path.join(publicSafe, 'blobs'))).toEqual([reference.blob.sha256]);
    for (const value of [manifest.rawEvidence.sha256, candidate.item.content.sha256, 'restricted-body-canary', input.latest.coverUrl, input.latest.reviewId]) {
      expect(bundleText).not.toContain(value);
      expect(metadata.toString('utf8')).not.toContain(value);
    }
    expect(candidate).toMatchObject({ publicationEligible: false, bundleIdentityEligible: true, bundleEligible: false });
    expect(manifest.rawEvidence).not.toHaveProperty('evidenceTier', 'public-safe');
    expect(manifest.shadowBundle).toMatchObject({ path: 'public-safe/bundle.json', decisionStatus: 'review-required' });
    expect(JSON.parse(await readFile(path.join(runRoot, 'source-policy.json'), 'utf8')).qualification.owner).toBe('synthetic-operator');
    for (const directory of [runRoot, publicSafe, path.join(runRoot, 'blobs'), path.join(publicSafe, 'blobs')]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of [
      path.join(publicSafe, 'bundle.json'), path.join(publicSafe, 'blobs', reference.blob.sha256),
      path.join(runRoot, 'blobs', manifest.rawEvidence.sha256), path.join(runRoot, 'candidate.json'),
      path.join(runRoot, 'run.json'), path.join(runRoot, 'source-policy.json'),
    ]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(['publisher-mismatch', 'expired', 'future', 'malicious-field', 'full', 'summary', 'link-only'])(
    'rejects %s source policies without persisting a run', async (kind) => {
      const runtime = await setupShadow();
      const policy = JSON.parse(await readFile(runtime.sourcePolicyPath, 'utf8'));
      if (kind === 'publisher-mismatch') policy.source.publisherIdentity.value = 'OTg3NjU0MzIxMA==';
      else if (kind === 'expired') policy.qualification.reviewUntil = '2026-10-07T13:00:00.000Z';
      else if (kind === 'future') policy.qualification.reviewedAt = '2026-10-08T00:00:00Z';
      else if (kind === 'malicious-field') policy.source.cookie = 'must-not-persist';
      else policy.source.redistributionMode = kind;
      await writeFile(runtime.sourcePolicyPath, JSON.stringify(policy), { mode: 0o600 });
      await expect(acquireWereadLatest(runtime)).rejects.toThrow();
      expect(await readdir(runtime.outputRoot)).toEqual([]);
    },
  );

  it('refuses source policies from protected provider state or symlinks', async () => {
    const runtime = await setupShadow();
    const protectedPolicy = path.join(runtime.protectedRoot, 'policy.json');
    await writeFile(protectedPolicy, await readFile(runtime.sourcePolicyPath), { mode: 0o600 });
    await expect(acquireWereadLatest({ ...runtime, sourcePolicyPath: protectedPolicy })).rejects.toThrow(/provider state/);
    const linkedPolicy = path.join(path.dirname(runtime.sourcePolicyPath), 'linked-policy.json');
    await symlink(runtime.sourcePolicyPath, linkedPolicy);
    await expect(acquireWereadLatest({ ...runtime, sourcePolicyPath: linkedPolicy })).rejects.toThrow(/symlink/);
    expect(await readdir(runtime.outputRoot)).toEqual([]);
  });

  it('refuses to read a provider export from the protected provider state', async () => {
    const runtime = await setup();
    const protectedInput = path.join(runtime.protectedRoot, 'latest.json');
    await writeFile(protectedInput, await readFile(runtime.inputPath), { mode: 0o600 });
    await expect(acquireWereadLatest({ ...runtime, inputPath: protectedInput }))
      .rejects.toThrow(/provider state/);
  });

  it('refuses output inside protected provider state', async () => {
    const runtime = await setup();
    await expect(acquireWereadLatest({ ...runtime, outputRoot: path.join(runtime.protectedRoot, 'shadow') }))
      .rejects.toThrow(/separate from repository and provider state/);
  });

  it('rejects secret-bearing or unknown provider export fields before persistence', async () => {
    const runtime = await setup();
    const raw = JSON.parse(await readFile(runtime.inputPath, 'utf8'));
    raw.token = 'must-not-persist';
    await writeFile(runtime.inputPath, JSON.stringify(raw), { mode: 0o600 });
    await expect(acquireWereadLatest(runtime)).rejects.toThrow();
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(runtime.outputRoot));
    expect(entries).toEqual([]);
  });
});
