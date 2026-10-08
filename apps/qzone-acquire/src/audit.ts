import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readVerifiedQzoneAcquisition } from './acquisition-evidence.js';
import { buildQzoneAuditLedger, parseQzoneAuditInputs, type QzoneAcquisitionSummary, type QzoneAuditLedger } from './audit-model.js';
import { qzonePolicySha256 } from './review-model.js';
import { offlinePaths, privateJson, restrictedRoot } from './storage.js';

export interface QzoneAuditOptions {
  auditPath: string;
  observationsPath: string;
  policyPath: string;
  outputRoot: string;
  protectedRoot: string;
}

export interface QzoneAuditResult {
  runId: string;
  counts: QzoneAuditLedger['counts'];
  rates: QzoneAuditLedger['rates'];
  publicationEligible: false;
  bundleEligible: false;
  benchmarkStarted: false;
}

/** Offline evidence qualification only; declarations do not authenticate the human audit. */
export async function auditQzoneSource(options: QzoneAuditOptions): Promise<QzoneAuditResult> {
  try {
    const basePaths = await offlinePaths([], [options.auditPath, options.observationsPath, options.policyPath],
      options.outputRoot, options.protectedRoot);
    const now = new Date();
    const { audit, observations, policy } = parseQzoneAuditInputs(
      await privateJson(basePaths.inputFiles[0]!), await privateJson(basePaths.inputFiles[1]!),
      await privateJson(basePaths.inputFiles[2]!), now,
    );
    const runDirectories = observations.attempts.flatMap((attempt) =>
      attempt.outcome === 'success' ? [attempt.runDirectory] : []);
    // Exclude every declared namespace before inspecting even the first acquisition.
    const paths = await offlinePaths(runDirectories, basePaths.inputFiles, basePaths.outputRoot, basePaths.protectedRoot);
    const summaries: QzoneAcquisitionSummary[] = [];
    for (const inputDir of paths.inputDirs) {
      const acquisition = await readVerifiedQzoneAcquisition(inputDir, policy, now);
      summaries.push({
        inputDir, runId: acquisition.runId, manifestSha256: acquisition.manifestSha256,
        sourceId: acquisition.sourceId, publisherIdentity: acquisition.publisherIdentity,
        startedAt: acquisition.startedAt, completedAt: acquisition.completedAt,
        items: acquisition.items.map(({ candidate, acquiredAt }) => ({
          sourceItemId: candidate.sourceItemId, nativeIdentity: candidate.nativeIdentity,
          publicationTime: candidate.publicationTime, acquiredAt, contentCompleteness: 'partial',
        })),
      });
      // Only compact identity/time summaries survive this iteration, never bodies or media.
    }
    const ledger = buildQzoneAuditLedger(audit, observations, policy, summaries, now);
    const runId = randomUUID();
    const files = [
      { filename: 'manual-audit.json', value: audit },
      { filename: 'observations.json', value: observations },
      { filename: 'source-policy.json', value: policy },
      { filename: 'ledger.json', value: ledger },
    ].map(({ filename, value }) => {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Oversized audit output');
      return {
        filename, bytes,
        descriptor: {
          filename, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
          contentType: 'application/json; charset=utf-8',
        },
      };
    });
    const manifest = {
      schemaVersion: 1, kind: 'qzone-audit', runId, startedAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false,
      sourcePolicySha256: qzonePolicySha256(policy), source: ledger.source,
      discovery: { complete: false, reason: 'provider-first-page-only' },
      files: files.map(({ descriptor }) => descriptor),
      successfulRuns: summaries.map(({ runId: inputRunId, manifestSha256 }) => ({ runId: inputRunId, manifestSha256 })),
    };
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n', 'utf8') > 2 * 1024 * 1024) {
      throw new Error('Oversized audit manifest');
    }
    // Ledger validation and every serialized file bound precede output creation.
    const root = await restrictedRoot(paths.outputRoot, paths.protectedRoot);
    const destination = path.join(root, runId);
    try {
      await lstat(destination);
      throw new Error('Audit run already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const staging = await mkdtemp(path.join(root, '.partial-'));
    try {
      for (const { filename, bytes } of files) {
        await writeFile(path.join(staging, filename), bytes, { mode: 0o600, flag: 'wx' });
      }
      manifest.completedAt = new Date().toISOString();
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('Oversized audit manifest');
      // Completion marker is last; only the final immutable UUID directory is complete.
      await writeFile(path.join(staging, 'run.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
      await rename(staging, destination);
    } catch (error) {
      await rm(path.join(staging, 'run.json'), { force: true });
      throw error;
    }
    return { runId, counts: ledger.counts, rates: ledger.rates,
      publicationEligible: false, bundleEligible: false, benchmarkStarted: false };
  } catch {
    throw new Error('QZone offline audit failed');
  }
}
