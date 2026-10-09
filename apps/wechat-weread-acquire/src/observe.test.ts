import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWereadLatest } from './acquire.js';
import { observeWereadSource } from './observe.js';

const bases: string[] = [];
const clock = '2026-10-08T13:00:00.000Z';
const publisherIdentity = { scheme: 'wechat-biz', version: 1, value: 'MTIzNDU2Nzg5MA==' };

interface ObservationFixture {
  base: string;
  inputPath: string;
  acquisitionRoot: string;
  observationsPath: string;
  outputRoot: string;
  protectedRoot: string;
}

async function setup(): Promise<ObservationFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nju-weread-observe-'));
  bases.push(base);
  const inputRoot = path.join(base, 'input');
  const acquisitionRoot = path.join(base, 'acquisitions');
  const protectedRoot = path.join(base, 'provider-state');
  for (const directory of [inputRoot, acquisitionRoot, protectedRoot]) await mkdir(directory, { mode: 0o700 });
  const inputPath = path.join(inputRoot, 'export.json');
  await writeFile(inputPath, await readFile(new URL('./fixtures/latest-export.json', import.meta.url)), { mode: 0o600 });
  const observationsPath = path.join(inputRoot, 'observations.json');
  const outputRoot = path.join(base, 'observations');
  return { base, inputPath, acquisitionRoot, observationsPath, outputRoot, protectedRoot };
}

async function declare(runtime: ObservationFixture, attempts: unknown[]) {
  await writeFile(runtime.observationsPath, JSON.stringify({ schemaVersion: 1, publisherIdentity, cutoffAt: clock, attempts }),
    { mode: 0o600 });
}

async function acquire(runtime: ObservationFixture) {
  const result = await acquireWereadLatest({ inputPath: runtime.inputPath,
    outputRoot: runtime.acquisitionRoot, protectedRoot: runtime.protectedRoot });
  return path.join(runtime.acquisitionRoot, result.runId);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(clock));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe('observeWereadSource', () => {
  it('deduplicates native identity across alias/content changes without logging provider content', async () => {
    const runtime = await setup();
    const input = JSON.parse(await readFile(runtime.inputPath, 'utf8'));
    input.latest.contentHtml = '<p>private-body-canary</p>';
    await writeFile(runtime.inputPath, JSON.stringify(input), { mode: 0o600 });
    const first = await acquire(runtime);
    input.acquiredAt = '2026-10-08T12:48:00.000Z';
    input.provider.version = 'synthetic-v2';
    input.latest.reviewId = `${input.feed.id}_differentReviewToken`;
    input.latest.contentHtml = '<p>changed-private-body</p>';
    await writeFile(runtime.inputPath, JSON.stringify(input), { mode: 0o600 });
    const second = await acquire(runtime);
    await declare(runtime, [{ outcome: 'success', runDirectory: second }, { outcome: 'success', runDirectory: first }]);
    const sourceBytes = await readFile(runtime.observationsPath);
    const priorRun = await readFile(path.join(first, 'run.json'));
    const result = await observeWereadSource(runtime);
    expect(result.counts).toMatchObject({ successfulRuns: 2, distinctNativeItems: 1, duplicateSightings: 1 });
    expect(result.lastSuccessAt).toBe('2026-10-08T12:48:00.000Z');
    expect(result.progress).toMatchObject({ cursor: null, coveredThrough: null,
      lastNewNativeItemAt: '2026-10-07T12:48:00.000Z', eligible: true });
    const root = path.join(runtime.outputRoot, result.runId);
    const ledgerText = await readFile(path.join(root, 'ledger.json'), 'utf8');
    const ledger = JSON.parse(ledgerText);
    expect(ledger.items[0]).toMatchObject({ sightingCount: 2, contentVariantCount: 2,
      firstSeenAt: '2026-10-07T12:48:00.000Z', lastSeenAt: '2026-10-08T12:48:00.000Z' });
    for (const secret of ['private-body-canary', 'changed-private-body', 'differentReviewToken', input.latest.coverUrl]) {
      expect(ledgerText).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(await readFile(runtime.observationsPath)).toEqual(sourceBytes);
    expect(await readFile(path.join(first, 'run.json'))).toEqual(priorRun);
    const manifest = JSON.parse(await readFile(path.join(root, 'run.json'), 'utf8'));
    for (const descriptor of manifest.files) {
      const bytes = await readFile(path.join(root, descriptor.filename));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256);
      expect(bytes.byteLength).toBe(descriptor.byteLength);
      expect(descriptor.contentType).toBe('application/json; charset=utf-8');
      expect((await stat(path.join(root, descriptor.filename))).mode & 0o777).toBe(0o600);
    }
    for (const reference of manifest.successfulRuns) {
      const bytes = await readFile(path.join(runtime.acquisitionRoot, reference.runId, 'run.json'));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.manifestSha256);
    }
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, 'run.json'))).mode & 0o777).toBe(0o600);
    expect(manifest).toMatchObject({ publicationEligible: false, bundleEligible: false, benchmarkStarted: false });
    expect(await readdir(root)).toEqual(expect.arrayContaining(['observations.json', 'ledger.json', 'run.json']));
    expect(await readdir(root)).not.toContain('public-safe');
  });

  it('keeps failure and empty attempts separate from progress, then records genuine recovery', async () => {
    const runtime = await setup();
    const first = await acquire(runtime);
    const success = { outcome: 'success', runDirectory: first };
    await declare(runtime, [success]);
    const baseline = await observeWereadSource(runtime);
    const failures = [
      { outcome: 'blocked', observedAt: '2026-10-08T12:49:00Z' },
      { outcome: 'error', observedAt: '2026-10-08T12:50:00Z' },
      { outcome: 'empty', observedAt: '2026-10-08T12:51:00Z' },
    ];
    await declare(runtime, [success, ...failures]);
    const failed = await observeWereadSource(runtime);
    expect(failed.progress).toEqual(baseline.progress);
    expect(failed.lastSuccessAt).toBe(baseline.lastSuccessAt);
    expect(failed.lastObservation).toEqual({ observedAt: '2026-10-08T12:51:00.000Z', outcomes: ['empty'] });
    expect(failed.counts).toMatchObject({ blockedAttempts: 1, errorAttempts: 1, emptyAttempts: 1 });
    const input = JSON.parse(await readFile(runtime.inputPath, 'utf8'));
    input.acquiredAt = '2026-10-08T12:55:00Z';
    input.latest.mid = '10002';
    input.latest.publicationUnixSeconds = String(Date.parse('2026-10-08T12:40:00Z') / 1000);
    await writeFile(runtime.inputPath, JSON.stringify(input), { mode: 0o600 });
    const recoveredRun = await acquire(runtime);
    await declare(runtime, [...failures, { outcome: 'success', runDirectory: recoveredRun }, success]);
    const recovered = await observeWereadSource(runtime);
    expect(recovered.lastSuccessAt).toBe('2026-10-08T12:55:00.000Z');
    expect(recovered.lastObservation).toEqual({ observedAt: '2026-10-08T12:55:00.000Z', outcomes: ['success'] });
    expect(recovered.progress.lastNewNativeItemAt).toBe('2026-10-08T12:55:00.000Z');
    expect(recovered.progress.latestKnownPublication?.publishedAt).toBe('2026-10-08T12:40:00.000Z');
    expect(recovered.counts.distinctNativeItems).toBe(2);
  });

  it.each(['empty', 'failure-only'])('emits no success or progress for %s declarations', async (kind) => {
    const runtime = await setup();
    await declare(runtime, kind === 'empty' ? [] : [{ outcome: 'blocked', observedAt: '2026-10-08T12:50:00Z' }]);
    const result = await observeWereadSource(runtime);
    expect(result.lastSuccessAt).toBeNull();
    expect(result.progress).toMatchObject({ eligible: false, lastNewNativeItemAt: null, latestKnownPublication: null,
      cursor: null, coveredThrough: null });
    expect(result.counts).toMatchObject({ successfulRuns: 0, distinctNativeItems: 0 });
  });

  it.each(['duplicate-run', 'missing-run', 'tampered-candidate', 'foreign-publisher', 'future-cutoff', 'secret-field']) (
    'rejects %s evidence without emitting a completed ledger', async (kind) => {
      const runtime = await setup();
      const directory = await acquire(runtime);
      const attempts = [{ outcome: 'success', runDirectory: directory }];
      if (kind === 'duplicate-run') attempts.push(attempts[0]!);
      if (kind === 'missing-run') await rm(path.join(directory, 'run.json'));
      if (kind === 'tampered-candidate') {
        const candidate = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
        candidate.item.sourceItemId = 'forged-identity';
        await writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate), { mode: 0o600 });
      }
      await declare(runtime, attempts);
      if (kind === 'foreign-publisher' || kind === 'future-cutoff' || kind === 'secret-field') {
        const input = JSON.parse(await readFile(runtime.observationsPath, 'utf8'));
        if (kind === 'foreign-publisher') input.publisherIdentity.value = 'OTg3NjU0MzIxMA==';
        if (kind === 'future-cutoff') input.cutoffAt = '2026-10-09T00:00:00Z';
        if (kind === 'secret-field') input.cookie = 'private-log-canary';
        await writeFile(runtime.observationsPath, JSON.stringify(input), { mode: 0o600 });
      }
      await expect(observeWereadSource(runtime)).rejects.toThrow(/^WeRead offline observation failed$/);
      await expect(stat(runtime.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['protected-run', 'output-overlap', 'symlink-input', 'public-input']) (
    'rejects unsafe %s namespaces before output creation', async (kind) => {
      const runtime = await setup();
      const directory = await acquire(runtime);
      await declare(runtime, [{ outcome: 'success', runDirectory: kind === 'protected-run' ? runtime.protectedRoot : directory }]);
      let options = { ...runtime };
      if (kind === 'output-overlap') options.outputRoot = path.join(directory, 'observations');
      if (kind === 'symlink-input') {
        const linked = path.join(path.dirname(runtime.observationsPath), 'linked.json');
        await symlink(runtime.observationsPath, linked);
        options.observationsPath = linked;
      }
      if (kind === 'public-input') await chmod(runtime.observationsPath, 0o644);
      await expect(observeWereadSource(options)).rejects.toThrow(/^WeRead offline observation failed$/);
      await expect(stat(options.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['dotdot', 'trailing-slash', 'repeated-separator', 'erased-symlink']) (
    'rejects noncanonical %s success references without output', async (kind) => {
      const runtime = await setup();
      const directory = await acquire(runtime);
      const runId = path.basename(directory);
      let alias = `${directory}/`;
      if (kind === 'dotdot') alias = `${runtime.acquisitionRoot}/../acquisitions/${runId}`;
      if (kind === 'repeated-separator') alias = `${runtime.acquisitionRoot}//${runId}`;
      if (kind === 'erased-symlink') {
        await symlink(path.join(runtime.protectedRoot, 'uninspected-target'), path.join(runtime.acquisitionRoot, 'alias'));
        alias = `${runtime.acquisitionRoot}/alias/../${runId}`;
      }
      await declare(runtime, [{ outcome: 'success', runDirectory: alias }]);
      await expect(observeWereadSource(runtime)).rejects.toThrow(/^WeRead offline observation failed$/);
      await expect(stat(runtime.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
