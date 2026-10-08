import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parseSocialAcquisitionBundle,
  type SocialAcquisitionBundle,
} from '@nju-info/core';
import { z } from 'zod';
import { readVerifiedQzoneAcquisition } from './acquisition-evidence.js';
import {
  applyQzoneReview,
  buildQzoneShadow,
  parseQzoneReviewPolicy,
  qzoneMetadataBytes,
  qzonePolicySha256,
  type QzoneReviewDecisions,
  type QzoneReviewRequest,
} from './review-model.js';
import { offlinePaths, parseJsonBytes, privateBytes, privateDirectory, privateJson, restrictedRoot } from './storage.js';

const jsonMime = 'application/json; charset=utf-8';
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true }).refine((value) =>
  !/\.\d{4,}/.test(value) && Number.isFinite(Date.parse(value)));
const discovery = { complete: false, reason: 'provider-first-page-only' } as const;
const countsSchema = z.object({
  approved: z.number().int().min(0).max(10), rejected: z.number().int().min(0).max(10),
  reviewRequired: z.number().int().min(0).max(10),
}).strict();
const offlineManifestSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['qzone-shadow', 'qzone-review']),
  runId: uuidSchema, startedAt: timestampSchema, completedAt: timestampSchema,
  publicationEligible: z.literal(false), bundleEligible: z.literal(false),
  discovery: z.object({ complete: z.literal(false), reason: z.literal('provider-first-page-only') }).strict(),
  itemCount: z.number().int().min(1).max(10), counts: countsSchema,
  sourcePolicySha256: hashSchema, bundleSha256: hashSchema,
  input: z.object({
    kind: z.enum(['qzone-acquisition', 'qzone-shadow']), runId: uuidSchema, manifestSha256: hashSchema,
  }).strict(),
}).strict();

export interface QzoneShadowOptions {
  inputDir: string;
  selectionPath: string;
  policyPath: string;
  outputRoot: string;
  protectedRoot: string;
}

export interface QzoneReviewOptions {
  inputDir: string;
  decisionsPath: string;
  policyPath: string;
  outputRoot: string;
  protectedRoot: string;
}

export interface QzoneOfflineReviewResult {
  runId: string;
  itemCount: number;
  approved: number;
  rejected: number;
  reviewRequired: number;
  publicationEligible: false;
  bundleEligible: false;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function completedRun(runId: string, inputDir: string, startedAt: string, completedAt: string, now: Date): void {
  if (path.basename(inputDir) !== runId || Date.parse(startedAt) > Date.parse(completedAt) ||
      Date.parse(completedAt) > now.getTime()) throw new Error('Invalid completed run');
}


interface OfflineWrite {
  outputRoot: string;
  protectedRoot: string;
  runId: string;
  startedAt: string;
  kind: 'qzone-shadow' | 'qzone-review';
  input: { kind: 'qzone-acquisition' | 'qzone-shadow'; runId: string; manifestSha256: string };
  policy: unknown;
  policySha256: string;
  bundle: SocialAcquisitionBundle;
  request: QzoneReviewRequest;
  record?: QzoneReviewDecisions;
  blobs: Array<{ sha256: string; bytes: Buffer }>;
  counts: { approved: number; rejected: number; reviewRequired: number };
}

async function writeOfflineRun(output: OfflineWrite): Promise<QzoneOfflineReviewResult> {
  const bundleBytes = jsonBytes(output.bundle);
  const files: Array<[string, Buffer]> = [
    ['source-policy.json', jsonBytes(output.policy)], ['review-request.json', jsonBytes(output.request)],
    ['public-safe/bundle.json', bundleBytes],
  ];
  if (output.record) files.push(['item-review.json', jsonBytes(output.record)]);
  // A successful run must remain readable by the same bounded offline readers.
  if (files.some(([, bytes]) => bytes.length > 2 * 1024 * 1024) ||
      output.blobs.some((blob) => blob.bytes.length > 2 * 1024 * 1024 || sha256(blob.bytes) !== blob.sha256)) {
    throw new Error('Oversized or invalid offline output');
  }
  const root = await restrictedRoot(output.outputRoot, output.protectedRoot);
  const staging = await mkdtemp(path.join(root, '.partial-'));
  const publicDir = path.join(staging, 'public-safe');
  await mkdir(publicDir, { mode: 0o700 });
  await mkdir(path.join(publicDir, 'blobs'), { mode: 0o700 });
  const stored = new Set<string>();
  for (const blob of output.blobs) {
    if (stored.has(blob.sha256)) continue;
    await writeFile(path.join(publicDir, 'blobs', blob.sha256), blob.bytes, { mode: 0o600, flag: 'wx' });
    stored.add(blob.sha256);
  }
  for (const [filename, bytes] of files) {
    await writeFile(path.join(staging, filename), bytes, { mode: 0o600, flag: 'wx' });
  }
  const manifest = offlineManifestSchema.parse({
    schemaVersion: 1, kind: output.kind, runId: output.runId, startedAt: output.startedAt,
    completedAt: new Date().toISOString(), publicationEligible: false, bundleEligible: false,
    discovery, itemCount: output.bundle.envelopes.length, counts: output.counts,
    sourcePolicySha256: output.policySha256, bundleSha256: sha256(bundleBytes), input: output.input,
  });
  const destination = path.join(root, output.runId);
  try {
    await lstat(destination);
    throw new Error('Offline run already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A manifest is the final staging write; only a final UUID directory is complete.
  try {
    await writeFile(path.join(staging, 'run.json'), jsonBytes(manifest), { mode: 0o600, flag: 'wx' });
    await rename(staging, destination);
  } catch (error) {
    await rm(path.join(staging, 'run.json'), { force: true });
    throw error;
  }
  return {
    runId: output.runId, itemCount: manifest.itemCount, ...output.counts,
    publicationEligible: false, bundleEligible: false,
  };
}

export async function createQzoneShadow(options: QzoneShadowOptions): Promise<QzoneOfflineReviewResult> {
  try {
    const paths = await offlinePaths([options.inputDir], [options.selectionPath, options.policyPath], options.outputRoot, options.protectedRoot);
    const now = new Date();
    const policy = parseQzoneReviewPolicy(await privateJson(paths.inputFiles[1]!), now);
    const selection = await privateJson(paths.inputFiles[0]!);
    const acquisition = await readVerifiedQzoneAcquisition(paths.inputDirs[0]!, policy, now);
    const runId = randomUUID();
    const shadow = buildQzoneShadow(acquisition.items, policy, selection, {
      provider: acquisition.provenance.provider,
      exporter: { name: '@nju-info/qzone-acquire', version: '0.0.0' },
    }, runId, now);
    return await writeOfflineRun({
      ...paths, runId, startedAt: now.toISOString(), kind: 'qzone-shadow',
      input: { kind: 'qzone-acquisition', runId: acquisition.runId, manifestSha256: acquisition.manifestSha256 },
      policy, policySha256: qzonePolicySha256(policy), bundle: shadow.bundle, request: shadow.request,
      blobs: shadow.metadataBlobs, counts: { approved: 0, rejected: 0, reviewRequired: shadow.bundle.envelopes.length },
    });
  } catch {
    throw new Error('QZone offline shadow failed');
  }
}

export async function reviewQzoneShadow(options: QzoneReviewOptions): Promise<QzoneOfflineReviewResult> {
  try {
    const paths = await offlinePaths([options.inputDir], [options.decisionsPath, options.policyPath], options.outputRoot, options.protectedRoot);
    const now = new Date();
    const policy = parseQzoneReviewPolicy(await privateJson(paths.inputFiles[1]!), now);
    const decisions = await privateJson(paths.inputFiles[0]!);
    const inputDir = paths.inputDirs[0]!;
    const manifestBytes = await privateBytes(path.join(inputDir, 'run.json'));
    const manifest = offlineManifestSchema.parse(parseJsonBytes(manifestBytes));
    completedRun(manifest.runId, inputDir, manifest.startedAt, manifest.completedAt, now);
    if (manifest.kind !== 'qzone-shadow' || manifest.input.kind !== 'qzone-acquisition' ||
        manifest.counts.approved !== 0 || manifest.counts.rejected !== 0 || manifest.counts.reviewRequired !== manifest.itemCount) {
      throw new Error('Not a pending shadow run');
    }
    const snapshot = parseQzoneReviewPolicy(await privateJson(path.join(inputDir, 'source-policy.json')), now);
    const policyHash = qzonePolicySha256(policy);
    if (policyHash !== manifest.sourcePolicySha256 || policyHash !== qzonePolicySha256(snapshot)) {
      throw new Error('Changed source policy');
    }
    const requestInput = await privateJson(path.join(inputDir, 'review-request.json'));
    if (typeof requestInput !== 'object' || requestInput === null ||
        !('preparedAt' in requestInput) || requestInput.preparedAt !== manifest.startedAt) {
      throw new Error('Changed shadow preparation time');
    }
    await privateDirectory(path.join(inputDir, 'public-safe'));
    await privateDirectory(path.join(inputDir, 'public-safe', 'blobs'));
    const bundleBytes = await privateBytes(path.join(inputDir, 'public-safe', 'bundle.json'));
    if (sha256(bundleBytes) !== manifest.bundleSha256) throw new Error('Changed bundle bytes');
    const bundle = parseSocialAcquisitionBundle(parseJsonBytes(bundleBytes));
    if (bundle.bundleId !== `qzone-shadow-v1:${manifest.runId}` || bundle.envelopes.length !== manifest.itemCount) {
      throw new Error('Changed shadow identity');
    }
    const blobs: Array<{ sha256: string; bytes: Buffer }> = [];
    for (const envelope of bundle.envelopes) {
      if (envelope.provenance.runId !== manifest.runId || envelope.decision.decidedAt !== manifest.startedAt ||
          !isDeepStrictEqual(envelope.payload.source, snapshot.source) || envelope.payload.rawBlobs.length !== 1) {
        throw new Error('Changed shadow source or provenance');
      }
      const reference = envelope.payload.rawBlobs[0]!;
      const bytes = await privateBytes(path.join(inputDir, 'public-safe', 'blobs', reference.blob.sha256));
      if (reference.blob.contentType !== jsonMime || bytes.length !== reference.blob.byteLength ||
          sha256(bytes) !== reference.blob.sha256 || !bytes.equals(qzoneMetadataBytes(envelope.payload))) {
        throw new Error('Invalid sanitized metadata');
      }
      blobs.push({ sha256: reference.blob.sha256, bytes });
    }
    const runId = randomUUID();
    const reviewed = applyQzoneReview(bundle, requestInput, decisions, policy, runId, now);
    // The model validates strict request shape and immutable bindings before this cast.
    const request = requestInput as QzoneReviewRequest;
    return await writeOfflineRun({
      ...paths, runId, startedAt: now.toISOString(), kind: 'qzone-review',
      input: { kind: 'qzone-shadow', runId: manifest.runId, manifestSha256: sha256(manifestBytes) },
      policy, policySha256: policyHash, bundle: reviewed.bundle, request,
      record: reviewed.reviewRecord, blobs, counts: reviewed.counts,
    });
  } catch {
    throw new Error('QZone offline review failed');
  }
}
