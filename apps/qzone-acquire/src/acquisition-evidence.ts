import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { socialEnvelopePayloadSchema, socialItemIdentitySchema, socialPublisherIdentitySchema } from '@nju-info/core';
import { z } from 'zod';
import { parseQzonePolicy, type QzonePolicy } from './config.js';
import { normalizeQzonePost, type QzoneCandidate } from './normalize.js';
import { parseJsonBytes, privateBytes, privateDirectory, privateJson } from './storage.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true }).refine((value) =>
  !/\.\d{4,}/.test(value) && Number.isFinite(Date.parse(value)));
const implementationSchema = z.object({ name: z.string().trim().min(1), version: z.string().trim().min(1) }).strict();
const blobSchema = z.object({
  sha256: hashSchema,
  contentType: z.literal('application/json; charset=utf-8'),
  byteLength: z.number().int().nonnegative().max(2 * 1024 * 1024),
}).strict();
const rawEvidenceSchema = z.object({
  blob: blobSchema,
  sourceUrl: socialEnvelopePayloadSchema.shape.item.shape.originalUrl,
  acquiredAt: timestampSchema,
  evidenceTier: z.literal('restricted'),
  evidenceKind: z.literal('provider-export'),
  sanitizationVersion: z.literal('qzone-positive-extraction-v1'),
}).strict();
const acquisitionManifestSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), startedAt: timestampSchema, completedAt: timestampSchema,
  evidenceTier: z.literal('restricted'), publicationEligible: z.literal(false), policy: z.unknown(),
  provenance: z.object({
    method: z.literal('credentialed-public-export'),
    provider: implementationSchema.extend({ name: z.literal('AstrBot') }),
    plugin: implementationSchema.extend({ name: z.literal('astrbot_plugin_qzone') }),
    exporter: implementationSchema.extend({ name: z.literal('@nju-info/qzone-acquire') }),
  }).strict(),
  discovery: z.object({
    complete: z.literal(false), reason: z.literal('provider-first-page-only'), requestedLimit: z.literal(10),
    listedCount: z.number().int().min(0).max(10), detailCount: z.number().int().min(0).max(10),
  }).strict(),
  feedEvidence: rawEvidenceSchema,
}).strict();
const candidateSchema = z.object({
  sourceItemId: socialEnvelopePayloadSchema.shape.item.shape.sourceItemId,
  publisherIdentity: socialPublisherIdentitySchema,
  nativeIdentity: socialItemIdentitySchema,
  originalUrl: socialEnvelopePayloadSchema.shape.item.shape.originalUrl,
  publicationTime: socialEnvelopePayloadSchema.shape.publicationTime,
  content: z.object({ text: z.string(), html: z.literal(''), completeness: z.literal('partial') }).strict(),
  media: z.array(z.object({
    position: z.number().int().nonnegative(),
    originalUrl: socialEnvelopePayloadSchema.shape.media.element.shape.originalUrl,
    acquisitionStatus: z.literal('not-requested'),
  }).strict()),
  attribution: z.object({
    relationship: z.literal('unknown'), verification: z.literal('unknown'), origin: z.null(), evidence: z.tuple([]),
  }).strict(),
  rawEvidence: rawEvidenceSchema,
}).strict();
const postSchema = z.object({
  uin: z.string(), tid: z.string(), created_at: z.number().int().positive().refine(Number.isSafeInteger),
  content: z.string(), mediaUrls: z.array(z.string()),
}).strict();

export interface VerifiedQzoneAcquisition {
  runId: string;
  startedAt: string;
  completedAt: string;
  manifestSha256: string;
  sourceId: string;
  publisherIdentity: QzoneCandidate['publisherIdentity'];
  provenance: {
    provider: { name: string; version: string };
    plugin: { name: string; version: string };
    exporter: { name: string; version: string };
  };
  items: Array<{ candidate: QzoneCandidate; acquiredAt: string }>;
}


function acquiredDuring(acquiredAt: string, startedAt: string, completedAt: string): void {
  if (Date.parse(acquiredAt) < Date.parse(startedAt) || Date.parse(acquiredAt) > Date.parse(completedAt)) {
    throw new Error('Invalid evidence acquisition time');
  }
}

async function evidenceBytes(inputDir: string, reference: z.infer<typeof rawEvidenceSchema>): Promise<Buffer> {
  const bytes = await privateBytes(path.join(inputDir, 'blobs', reference.blob.sha256));
  if (createHash('sha256').update(bytes).digest('hex') !== reference.blob.sha256 || bytes.length !== reference.blob.byteLength) {
    throw new Error('Invalid acquisition evidence');
  }
  return bytes;
}

/** Read only after offlinePaths has guarded every input and output namespace. */
export async function readVerifiedQzoneAcquisition(
  inputDir: string, currentPolicy: QzonePolicy, now = new Date(),
): Promise<VerifiedQzoneAcquisition> {
  const manifestBytes = await privateBytes(path.join(inputDir, 'run.json'));
  const manifest = acquisitionManifestSchema.parse(parseJsonBytes(manifestBytes));
  if (path.basename(inputDir) !== manifest.runId || Date.parse(manifest.startedAt) > Date.parse(manifest.completedAt) ||
      Date.parse(manifest.completedAt) > now.getTime()) throw new Error('Invalid completed run');
  const historicalPolicy = parseQzonePolicy(manifest.policy, new Date(manifest.startedAt));
  timestampSchema.parse(historicalPolicy.qualification.reviewedAt);
  timestampSchema.parse(historicalPolicy.qualification.reviewUntil);
  const publisherIdentity = historicalPolicy.source.publisherIdentity;
  if (publisherIdentity.scheme !== 'qzone-uin') throw new Error('Invalid QZone publisher identity');
  if (historicalPolicy.source.sourceId !== currentPolicy.source.sourceId ||
      !isDeepStrictEqual(historicalPolicy.source.publisherIdentity, currentPolicy.source.publisherIdentity)) {
    throw new Error('Changed source identity');
  }
  const candidates = z.array(candidateSchema).max(10).parse(await privateJson(path.join(inputDir, 'candidates.json')));
  if (manifest.discovery.detailCount !== candidates.length || manifest.discovery.listedCount !== candidates.length) {
    throw new Error('Invalid discovery counts');
  }
  const uin = currentPolicy.source.publisherIdentity.value;
  if (manifest.feedEvidence.sourceUrl !== `https://user.qzone.qq.com/${uin}`) throw new Error('Invalid feed source');
  acquiredDuring(manifest.feedEvidence.acquiredAt, manifest.startedAt, manifest.completedAt);
  await privateDirectory(path.join(inputDir, 'blobs'));
  const feed = z.array(postSchema).max(10).parse(parseJsonBytes(await evidenceBytes(inputDir, manifest.feedEvidence)));
  if (feed.length !== candidates.length) throw new Error('Invalid feed count');
  const identities = new Set<string>();
  const feedCandidates = feed.map((post) => {
    const candidate = normalizeQzonePost(post);
    if (post.uin !== uin || identities.has(candidate.sourceItemId)) throw new Error('Invalid feed identity');
    identities.add(candidate.sourceItemId);
    return candidate;
  });
  const items: VerifiedQzoneAcquisition['items'] = [];
  const detailIds = new Set<string>();
  for (const [index, storedCandidate] of candidates.entries()) {
    const { rawEvidence, ...candidate } = storedCandidate;
    acquiredDuring(rawEvidence.acquiredAt, manifest.feedEvidence.acquiredAt, manifest.completedAt);
    const detail = postSchema.parse(parseJsonBytes(await evidenceBytes(inputDir, rawEvidence)));
    const normalized = normalizeQzonePost(detail);
    if (detail.uin !== uin || rawEvidence.sourceUrl !== normalized.originalUrl ||
        detailIds.has(normalized.sourceItemId) || normalized.sourceItemId !== feedCandidates[index]!.sourceItemId ||
        !isDeepStrictEqual(candidate, normalized)) throw new Error('Invalid candidate projection');
    detailIds.add(normalized.sourceItemId);
    items.push({ candidate: normalized, acquiredAt: rawEvidence.acquiredAt });
  }
  return {
    runId: manifest.runId, startedAt: manifest.startedAt, completedAt: manifest.completedAt,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), sourceId: historicalPolicy.source.sourceId,
    publisherIdentity,
    provenance: { provider: manifest.provenance.provider, plugin: manifest.provenance.plugin, exporter: manifest.provenance.exporter },
    items,
  };
}
