import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { normalizeWereadLatest } from './normalize.js';
import type { WereadObservationSuccess } from './observation-types.js';
import { parseJsonBytes, privateBytes, privateDirectory, privateJson } from './storage.js';

const runIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const timestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)),
);
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  runId: runIdSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema,
  evidenceTier: z.literal('restricted'),
  publicationEligible: z.literal(false),
  bundleIdentityEligible: z.literal(true),
  bundleEligible: z.literal(false),
  shadowBundle: z.object({
    path: z.literal('public-safe/bundle.json'),
    decisionStatus: z.literal('review-required'),
    policyVersion: z.string().min(1),
  }).strict().nullable(),
  identityStatus: z.literal('complete'),
  missingNativeIdentity: z.array(z.never()).length(0),
  discovery: z.object({
    complete: z.literal(false),
    reason: z.literal('weread-cover-latest-only'),
  }).strict(),
  candidate: z.object({
    shadowItemId: z.string().regex(/^wechat-weread-review-v1:[0-9a-f]{64}$/),
    sourceItemId: z.string().min(1),
    providerFeedId: z.string().regex(/^MP_WXS_[1-9]\d*$/),
    providerReviewId: z.string().min(1),
  }).strict(),
  rawEvidence: z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentType: z.literal('application/json; charset=utf-8'),
    byteLength: z.number().int().positive().max(2 * 1024 * 1024),
    evidenceKind: z.literal('provider-export'),
    sanitizationVersion: z.literal('werss-weread-positive-export-v2'),
  }).strict(),
  provenance: z.object({
    acquiredAt: timestampSchema,
    method: z.literal('credentialed-public-export'),
    provider: z.object({
      name: z.literal('WeRSS'),
      version: z.string().min(1),
      mode: z.literal('weread_mp'),
    }).strict(),
    exporter: z.object({
      name: z.literal('@nju-info/wechat-weread-acquire'),
      version: z.literal('0.0.0'),
    }).strict(),
  }).strict(),
}).strict();

/** Verify restricted qualification evidence, never shadow publication authority.
 * The caller must collectively exclude its declared protected namespace with
 * offlinePaths before invoking this reader. No input artifact is mutated.
 */
export async function readVerifiedWereadAcquisition(inputDir: string, cutoff: Date): Promise<WereadObservationSuccess> {
  if (!Number.isFinite(cutoff.getTime())) throw new Error('Invalid observation cutoff');
  if (!path.isAbsolute(inputDir) || path.resolve(inputDir) !== inputDir || /[\u0000-\u001f\u007f]/.test(inputDir)) {
    throw new Error('Invalid canonical acquisition directory');
  }
  const directoryRunId = runIdSchema.safeParse(path.basename(inputDir));
  if (!directoryRunId.success) throw new Error('Acquisition directory must be a completed canonical UUID run');
  await privateDirectory(inputDir);
  const manifestBytes = await privateBytes(path.join(inputDir, 'run.json'));
  const manifest = manifestSchema.parse(parseJsonBytes(manifestBytes));
  if (manifest.runId !== directoryRunId.data) throw new Error('Acquisition directory and manifest runId mismatch');

  const rawBytes = await privateBytes(path.join(inputDir, 'blobs', manifest.rawEvidence.sha256));
  if (rawBytes.byteLength !== manifest.rawEvidence.byteLength ||
      createHash('sha256').update(rawBytes).digest('hex') !== manifest.rawEvidence.sha256) {
    throw new Error('Acquisition raw export descriptor mismatch');
  }
  // Reconstruct every candidate field, including native sourceItemId, from the
  // exact original export. JSON property order is not an integrity criterion.
  const candidate = normalizeWereadLatest(parseJsonBytes(rawBytes));
  const storedCandidate = await privateJson(path.join(inputDir, 'candidate.json'));
  if (!isDeepStrictEqual(candidate, storedCandidate)) throw new Error('Acquisition candidate differs from normalized raw export');
  if (!isDeepStrictEqual(manifest.candidate, {
    shadowItemId: candidate.shadowItemId,
    sourceItemId: candidate.item.sourceItemId,
    providerFeedId: candidate.source.providerFeedId,
    providerReviewId: candidate.item.providerReviewId,
  }) || !isDeepStrictEqual(manifest.provenance, candidate.provenance) ||
      !isDeepStrictEqual(manifest.discovery, candidate.discovery)) {
    throw new Error('Acquisition manifest projection mismatch');
  }

  const acquiredAt = new Date(candidate.provenance.acquiredAt);
  const startedAt = new Date(manifest.startedAt);
  const completedAt = new Date(manifest.completedAt);
  const publishedAt = candidate.item.publicationTime.normalizedAt;
  if (publishedAt === null || new Date(publishedAt).getTime() > acquiredAt.getTime() ||
      acquiredAt.getTime() > startedAt.getTime() || startedAt.getTime() > completedAt.getTime() ||
      completedAt.getTime() > cutoff.getTime()) {
    throw new Error('Invalid acquisition clock ordering');
  }

  // Shadow metadata is structurally review-required above; its bundle, body and
  // source policy deliberately do not enter observation qualification evidence.
  return {
    inputDir,
    runId: manifest.runId,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    publisherIdentity: candidate.source.publisherIdentity,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    acquiredAt: acquiredAt.toISOString(),
    sourceItemId: candidate.item.sourceItemId,
    nativeIdentity: candidate.item.nativeIdentity,
    publicationTime: candidate.item.publicationTime,
    contentSha256: candidate.item.content.sha256,
  };
}
