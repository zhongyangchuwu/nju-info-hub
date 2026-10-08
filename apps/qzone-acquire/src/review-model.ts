import { createHash } from 'node:crypto';
import {
  parseSocialAcquisitionBundle,
  socialEnvelopePayloadSchema,
  socialPublicationBinding,
  type SocialAcquisitionBundle,
  type SocialEnvelopePayload,
} from '@nju-info/core';
import { z } from 'zod';
import { parseQzonePolicy, type QzonePolicy } from './config.js';
import type { QzoneCandidate } from './normalize.js';

export interface VerifiedQzoneItem {
  candidate: QzoneCandidate;
  acquiredAt: string;
}

export interface QzoneReviewProvenance {
  provider: { name: string; version: string };
  exporter: { name: string; version: string };
}

export interface QzoneReviewRequest {
  schemaVersion: 1;
  bundleId: string;
  policySha256: string;
  preparedAt: string;
  items: Array<{ sourceItemId: string; binding: { payloadSha256: string; mediaSha256s: string[] } }>;
}

export interface QzoneReviewDecisions {
  schemaVersion: 1;
  bundleId: string;
  policySha256: string;
  reviewer: string;
  reviewedAt: string;
  items: Array<{
    sourceItemId: string;
    binding: { payloadSha256: string; mediaSha256s: string[] };
    status: 'approved' | 'rejected' | 'review-required';
    reason: string;
  }>;
}

const sanitizationVersion = 'qzone-link-metadata-v1';
const metadataContentType = 'application/json; charset=utf-8';
const publicReasons = {
  approved: 'Offline item-review declaration approves only sanitized link metadata; this is not publication authority.',
  rejected: 'Offline item-review declaration rejects this item; no publication approval is asserted.',
  'review-required': 'Sanitized link metadata only; no publication approval is asserted, and item review is required.',
};
const nonblank = z.string().refine((value) => value.trim().length > 0);
const timestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)),
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceItemIdSchema = z.string().regex(/^social-native-v1:[a-f0-9]{64}$/);
const bindingSchema = z.object({
  payloadSha256: sha256Schema,
  mediaSha256s: z.array(sha256Schema).max(0),
}).strict();
const selectionSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.object({ sourceItemId: sourceItemIdSchema, title: nonblank.nullable() }).strict()).min(1).max(10),
}).strict();
const requestSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: nonblank,
  policySha256: sha256Schema,
  preparedAt: timestampSchema,
  items: z.array(z.object({ sourceItemId: sourceItemIdSchema, binding: bindingSchema }).strict()).min(1).max(10),
}).strict();
const decisionsSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: nonblank,
  policySha256: sha256Schema,
  reviewer: nonblank,
  reviewedAt: timestampSchema,
  items: z.array(z.object({
    sourceItemId: sourceItemIdSchema,
    binding: bindingSchema,
    status: z.enum(['approved', 'rejected', 'review-required']),
    reason: nonblank,
  }).strict()).min(1).max(10),
}).strict();
const provenanceSchema = z.object({
  provider: z.object({ name: nonblank, version: nonblank }).strict(),
  exporter: z.object({ name: nonblank, version: nonblank }).strict(),
}).strict();
const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  sanitizationVersion: z.literal(sanitizationVersion),
  platform: z.literal('qzone'),
  publisherIdentity: socialEnvelopePayloadSchema.shape.source.shape.publisherIdentity,
  item: socialEnvelopePayloadSchema.shape.item,
  publicationTime: socialEnvelopePayloadSchema.shape.publicationTime,
  content: socialEnvelopePayloadSchema.shape.content,
  attribution: socialEnvelopePayloadSchema.shape.attribution,
}).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(message);
  return result.data;
}

function clock(now: Date): number {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds) || !timestampSchema.safeParse(now.toISOString()).success) {
    throw new Error('Invalid QZone review clock');
  }
  return milliseconds;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseBundle(input: unknown): SocialAcquisitionBundle {
  try {
    return parseSocialAcquisitionBundle(input);
  } catch {
    throw new Error('Invalid QZone review bundle');
  }
}

/** The complete qualification stays restricted, but is part of the stale-policy binding. */
export function parseQzoneReviewPolicy(input: unknown, now: Date = new Date()): QzonePolicy {
  const currentTime = clock(now);
  const policy = parseQzonePolicy(input, now);
  const { source, qualification } = policy;
  if ((source.role !== 'relay' && source.role !== 'sentinel') || source.redistributionMode !== 'review-only' ||
      !source.displayName.trim() || !source.policyVersion.trim()) {
    throw new Error('QZone offline review requires a public relay or sentinel review-only policy');
  }
  const reviewedAt = parse(timestampSchema, qualification.reviewedAt, 'Invalid QZone qualification timestamp');
  const reviewUntil = parse(timestampSchema, qualification.reviewUntil, 'Invalid QZone qualification timestamp');
  if (Date.parse(reviewedAt) > currentTime || Date.parse(reviewedAt) >= Date.parse(reviewUntil) ||
      Date.parse(reviewUntil) <= currentTime) {
    throw new Error('QZone source qualification is not currently valid');
  }
  return policy;
}

export function qzonePolicySha256(policy: QzonePolicy): string {
  // Hashing is independent of today's clock; callers enforce current validity separately.
  const parsed = parseQzoneReviewPolicy(policy, new Date(policy.qualification.reviewedAt));
  return sha256(JSON.stringify(parsed));
}

function assertLinkMetadata(payload: SocialEnvelopePayload): void {
  if (payload.source.platform !== 'qzone' || payload.source.publisherIdentity.scheme !== 'qzone-uin' ||
      payload.item.nativeIdentity.scheme !== 'qzone-tid' || payload.item.aliases.length !== 0 ||
      payload.item.originalUrl !== payload.item.canonicalUrl || payload.content.text !== '' ||
      payload.content.html !== '' || payload.content.completeness !== 'link-only' ||
      (payload.content.title !== null && !payload.content.title.trim()) ||
      payload.media.length !== 0 || payload.attachments.length !== 0 ||
      payload.attribution.relationship !== 'unknown' || payload.attribution.verification !== 'unknown' ||
      payload.attribution.origin !== null || payload.attribution.evidence.length !== 0) {
    throw new Error('QZone review requires sanitized link metadata');
  }
}

/** Fixed positive projection; raw descriptors and restricted qualification are never serialized. */
export function qzoneMetadataBytes(payload: SocialEnvelopePayload): Buffer {
  assertLinkMetadata(payload);
  const metadata = parse(metadataSchema, {
    schemaVersion: 1,
    sanitizationVersion,
    platform: 'qzone',
    publisherIdentity: payload.source.publisherIdentity,
    item: payload.item,
    publicationTime: payload.publicationTime,
    content: payload.content,
    attribution: payload.attribution,
  }, 'Invalid QZone link metadata');
  return Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8');
}

export function buildQzoneShadow(
  items: VerifiedQzoneItem[],
  policyInput: unknown,
  selectionInput: unknown,
  provenance: QzoneReviewProvenance,
  runId: string,
  now: Date = new Date(),
): { bundle: SocialAcquisitionBundle; metadataBlobs: Array<{ sha256: string; bytes: Buffer }>; request: QzoneReviewRequest } {
  const currentTime = clock(now);
  const policy = parseQzoneReviewPolicy(policyInput, now);
  parse(z.uuid(), runId, 'Invalid QZone review run ID');
  const implementations = parse(provenanceSchema, provenance, 'Invalid QZone review provenance');
  const selection = parse(selectionSchema, selectionInput, 'Invalid QZone item selection');
  const available = new Map<string, VerifiedQzoneItem>();
  for (const item of items) {
    const publisher = parse(socialEnvelopePayloadSchema.shape.source.shape.publisherIdentity,
      item.candidate.publisherIdentity, 'Invalid QZone candidate publisher');
    if (available.has(item.candidate.sourceItemId) || publisher.scheme !== policy.source.publisherIdentity.scheme ||
        publisher.version !== policy.source.publisherIdentity.version || publisher.value !== policy.source.publisherIdentity.value) {
      throw new Error('QZone candidate identity does not match the reviewed policy');
    }
    const acquiredAt = parse(timestampSchema, item.acquiredAt, 'Invalid QZone acquisition timestamp');
    if (Date.parse(acquiredAt) > currentTime) throw new Error('Invalid QZone acquisition timestamp');
    available.set(item.candidate.sourceItemId, item);
  }
  const selected = new Set<string>();
  const metadataBlobs: Array<{ sha256: string; bytes: Buffer }> = [];
  const envelopes = selection.items.map(({ sourceItemId, title }) => {
    const verified = available.get(sourceItemId);
    if (selected.has(sourceItemId) || verified === undefined) throw new Error('Invalid QZone item selection');
    selected.add(sourceItemId);
    const { candidate, acquiredAt } = verified;
    const payload: SocialEnvelopePayload = {
      source: policy.source,
      item: {
        nativeIdentity: candidate.nativeIdentity,
        sourceItemId: candidate.sourceItemId,
        originalUrl: candidate.originalUrl,
        canonicalUrl: candidate.originalUrl,
        aliases: [],
      },
      publicationTime: candidate.publicationTime,
      content: { title, text: '', html: '', completeness: 'link-only' },
      media: [],
      attachments: [],
      attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
      rawBlobs: [],
    };
    const bytes = qzoneMetadataBytes(payload);
    const hash = sha256(bytes);
    metadataBlobs.push({ sha256: hash, bytes });
    payload.rawBlobs.push({
      blob: { sha256: hash, contentType: metadataContentType, byteLength: bytes.byteLength },
      sourceUrl: candidate.originalUrl,
      acquiredAt,
      evidenceTier: 'public-safe',
      evidenceKind: 'provider-export',
      sanitizationVersion,
    });
    const parsedPayload = parse(socialEnvelopePayloadSchema, payload, 'Invalid QZone shadow payload');
    return {
      schemaVersion: 1,
      payload: parsedPayload,
      provenance: { acquiredAt, method: 'credentialed-public-export', ...implementations, runId },
      decision: {
        status: 'review-required',
        mode: 'none',
        method: 'item-review',
        policyVersion: policy.source.policyVersion,
        decidedAt: now.toISOString(),
        reason: publicReasons['review-required'],
        binding: socialPublicationBinding(parsedPayload),
      },
    };
  });
  const bundle = parseBundle({ schemaVersion: 1, bundleId: `qzone-shadow-v1:${runId}`, envelopes });
  return {
    bundle,
    metadataBlobs,
    request: {
      schemaVersion: 1,
      bundleId: bundle.bundleId,
      policySha256: qzonePolicySha256(policy),
      preparedAt: now.toISOString(),
      items: bundle.envelopes.map(({ payload, decision }) => ({ sourceItemId: payload.item.sourceItemId, binding: decision.binding })),
    },
  };
}

function exactCoverage<T extends { sourceItemId: string; binding: QzoneReviewRequest['items'][number]['binding'] }>(
  items: T[],
  expected: Map<string, QzoneReviewRequest['items'][number]['binding']>,
): Map<string, T> {
  const actual = new Map<string, T>();
  for (const item of items) {
    const binding = expected.get(item.sourceItemId);
    if (actual.has(item.sourceItemId) || binding === undefined ||
        item.binding.payloadSha256 !== binding.payloadSha256 ||
        JSON.stringify(item.binding.mediaSha256s) !== JSON.stringify(binding.mediaSha256s)) {
      throw new Error('QZone review item coverage or payload binding mismatch');
    }
    actual.set(item.sourceItemId, item);
  }
  if (actual.size !== expected.size) throw new Error('QZone review item coverage or payload binding mismatch');
  return actual;
}

export function applyQzoneReview(
  bundleInput: unknown,
  requestInput: unknown,
  decisionsInput: unknown,
  currentPolicyInput: unknown,
  runId: string,
  now: Date = new Date(),
): { bundle: SocialAcquisitionBundle; reviewRecord: QzoneReviewDecisions; counts: { approved: number; rejected: number; reviewRequired: number } } {
  const currentTime = clock(now);
  parse(z.uuid(), runId, 'Invalid QZone review run ID');
  const policy = parseQzoneReviewPolicy(currentPolicyInput, now);
  const bundle = parseBundle(bundleInput);
  const request = parse(requestSchema, requestInput, 'Invalid QZone review request');
  const reviewRecord = parse(decisionsSchema, decisionsInput, 'Invalid QZone review decisions');
  const shadowRunId = bundle.bundleId.replace(/^qzone-shadow-v1:/, '');
  if (bundle.bundleId !== `qzone-shadow-v1:${shadowRunId}` || !z.uuid().safeParse(shadowRunId).success ||
      bundle.envelopes.length > 10 || request.bundleId !== bundle.bundleId || reviewRecord.bundleId !== bundle.bundleId ||
      request.policySha256 !== qzonePolicySha256(policy) || reviewRecord.policySha256 !== request.policySha256) {
    throw new Error('QZone review bundle or current policy mismatch');
  }
  const preparedAt = Date.parse(request.preparedAt);
  const reviewedAt = Date.parse(reviewRecord.reviewedAt);
  if (preparedAt > currentTime || preparedAt < Date.parse(policy.qualification.reviewedAt) ||
      reviewedAt < preparedAt || reviewedAt > currentTime) {
    throw new Error('QZone review timestamps are not currently valid');
  }
  const bindings = new Map<string, QzoneReviewRequest['items'][number]['binding']>();
  for (const envelope of bundle.envelopes) {
    const { payload, provenance, decision } = envelope;
    assertLinkMetadata(payload);
    if (JSON.stringify(payload.source) !== JSON.stringify(policy.source) ||
        bindings.has(payload.item.sourceItemId) || payload.rawBlobs.length !== 1 ||
        provenance.method !== 'credentialed-public-export' || provenance.runId !== shadowRunId ||
        decision.status !== 'review-required' || decision.mode !== 'none' || decision.method !== 'item-review' ||
        decision.decidedAt !== request.preparedAt || decision.reason !== publicReasons['review-required']) {
      throw new Error('QZone review requires an unchanged pending shadow');
    }
    parse(provenanceSchema, { provider: provenance.provider, exporter: provenance.exporter }, 'Invalid QZone review provenance');
    const acquiredAt = parse(timestampSchema, provenance.acquiredAt, 'Invalid QZone acquisition timestamp');
    const raw = payload.rawBlobs[0]!;
    const bytes = qzoneMetadataBytes(payload);
    if (Date.parse(acquiredAt) > preparedAt || raw.acquiredAt !== acquiredAt || raw.sourceUrl !== payload.item.canonicalUrl ||
        raw.evidenceTier !== 'public-safe' || raw.evidenceKind !== 'provider-export' || raw.sanitizationVersion !== sanitizationVersion ||
        raw.blob.sha256 !== sha256(bytes) || raw.blob.byteLength !== bytes.byteLength || raw.blob.contentType !== metadataContentType) {
      throw new Error('QZone review metadata descriptor mismatch');
    }
    bindings.set(payload.item.sourceItemId, socialPublicationBinding(payload));
  }
  exactCoverage(request.items, bindings);
  const decisions = exactCoverage(reviewRecord.items, bindings);
  const counts = { approved: 0, rejected: 0, reviewRequired: 0 };
  const envelopes = bundle.envelopes.map((envelope) => {
    const declared = decisions.get(envelope.payload.item.sourceItemId)!;
    if (declared.status === 'review-required') counts.reviewRequired += 1;
    else counts[declared.status] += 1;
    return {
      ...envelope,
      provenance: { ...envelope.provenance, runId },
      decision: {
        ...envelope.decision,
        status: declared.status,
        mode: declared.status === 'approved' ? 'link-only' : 'none',
        decidedAt: reviewRecord.reviewedAt,
        reason: publicReasons[declared.status],
      },
    };
  });
  return {
    bundle: parseBundle({ schemaVersion: 1, bundleId: `qzone-review-v1:${runId}`, envelopes }),
    reviewRecord,
    counts,
  };
}
