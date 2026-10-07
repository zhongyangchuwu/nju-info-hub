import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  return { base, inputPath, outputRoot, protectedRoot };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('acquireWereadLatest', () => {
  it('writes restricted evidence and an explicitly ineligible candidate', async () => {
    const runtime = await setup();
    const result = await acquireWereadLatest(runtime);
    expect(result.bundleEligible).toBe(false);

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
