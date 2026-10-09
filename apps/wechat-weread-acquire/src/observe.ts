import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readVerifiedWereadAcquisition } from './acquisition-evidence.js';
import { buildWereadObservationLedger, parseWereadObservations, type WereadObservationLedger } from './observation-model.js';
import type { WereadObservationSuccess } from './observation-types.js';
import { offlinePaths, privateJson, restrictedRoot } from './storage.js';

export interface WereadObserveOptions {
  observationsPath: string;
  outputRoot: string;
  protectedRoot: string;
}

export interface WereadObserveResult {
  runId: string;
  counts: WereadObservationLedger['counts'];
  lastObservation: WereadObservationLedger['lastObservation'];
  lastSuccessAt: WereadObservationLedger['lastSuccessAt'];
  progress: WereadObservationLedger['progress'];
  publicationEligible: false;
  bundleEligible: false;
  benchmarkStarted: false;
}

/** No upstream access; failed/empty attempts are declarations, not provider authentication. */
export async function observeWereadSource(options: WereadObserveOptions): Promise<WereadObserveResult> {
  try {
    const base = await offlinePaths([], [options.observationsPath], options.outputRoot, options.protectedRoot);
    const now = new Date();
    const observations = parseWereadObservations(await privateJson(base.inputFiles[0]!), now);
    const directories = observations.attempts.flatMap((attempt) =>
      attempt.outcome === 'success' ? [attempt.runDirectory] : []);
    // Exclude every declared namespace before reading the first successful run.
    const paths = await offlinePaths(directories, base.inputFiles, base.outputRoot, base.protectedRoot);
    const successes: WereadObservationSuccess[] = [];
    for (const directory of paths.inputDirs) {
      successes.push(await readVerifiedWereadAcquisition(directory, new Date(observations.cutoffAt)));
    }
    const ledger = buildWereadObservationLedger(observations, successes, now);
    const runId = randomUUID();
    const files = [
      { filename: 'observations.json', value: observations },
      { filename: 'ledger.json', value: ledger },
    ].map(({ filename, value }) => {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Oversized observation output');
      return { filename, bytes, descriptor: {
        filename, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
        contentType: 'application/json; charset=utf-8',
      } };
    });
    const manifest = {
      schemaVersion: 1, kind: 'weread-observation', runId, startedAt: now.toISOString(),
      completedAt: new Date().toISOString(), evidenceTier: 'restricted',
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false,
      source: ledger.source, discovery: ledger.discovery,
      files: files.map(({ descriptor }) => descriptor),
      successfulRuns: successes.map(({ runId: inputRunId, manifestSha256 }) => ({ runId: inputRunId, manifestSha256 })),
    };
    const root = await restrictedRoot(paths.outputRoot, paths.protectedRoot);
    const destination = path.join(root, runId);
    try {
      await lstat(destination);
      throw new Error('Observation run already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const staging = await mkdtemp(path.join(root, '.partial-'));
    try {
      for (const { filename, bytes } of files) {
        await writeFile(path.join(staging, filename), bytes, { flag: 'wx', mode: 0o600 });
      }
      manifest.completedAt = new Date().toISOString();
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Oversized observation manifest');
      await writeFile(path.join(staging, 'run.json'), bytes, { flag: 'wx', mode: 0o600 });
      await rename(staging, destination);
    } catch (error) {
      // A failed write is never a completed observation. Keep partial evidence private.
      await rm(path.join(staging, 'run.json'), { force: true });
      throw error;
    }
    return { runId, counts: ledger.counts, lastObservation: ledger.lastObservation,
      lastSuccessAt: ledger.lastSuccessAt, progress: ledger.progress,
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false };
  } catch {
    // Provider input, local paths and arbitrary parser details must not reach CLI logs.
    throw new Error('WeRead offline observation failed');
  }
}
