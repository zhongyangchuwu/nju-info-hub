import { createHash } from 'node:crypto';
import {
  parseSocialAcquisitionBundle,
  socialEnvelopePayloadSchema,
  socialPublicationBinding,
  type SocialAcquisitionBundle,
  type SocialEnvelopePayload,
} from '@nju-info/core';
import type { WereadLatestCandidate } from './normalize.js';
import { parseWechatSourcePolicy } from './policy.js';

const sanitizationVersion = 'wechat-weread-link-metadata-v1';
const reviewReason = 'Sanitized link metadata only; no publication approval is asserted, and item review is required.';

export function buildWereadShadowBundle(
  candidate: WereadLatestCandidate,
  policyInput: unknown,
  runId: string,
  now: Date = new Date(),
): { bundle: SocialAcquisitionBundle; metadataBytes: Buffer } {
  const policy = parseWechatSourcePolicy(policyInput, now);
  if (candidate.platform !== 'wechat') throw new Error('Weread candidate must use the wechat platform');

  const candidatePublisher = socialEnvelopePayloadSchema.shape.source.shape.publisherIdentity
    .parse(candidate.source.publisherIdentity);
  const policyPublisher = policy.source.publisherIdentity;
  if (candidatePublisher.scheme !== policyPublisher.scheme ||
      candidatePublisher.version !== policyPublisher.version ||
      candidatePublisher.value !== policyPublisher.value) {
    throw new Error('Weread candidate publisher identity does not match the reviewed policy');
  }

  const item = socialEnvelopePayloadSchema.shape.item.parse({
    nativeIdentity: candidate.item.nativeIdentity,
    sourceItemId: candidate.item.sourceItemId,
    originalUrl: candidate.item.originalUrl,
    canonicalUrl: candidate.item.canonicalUrl,
    aliases: [],
  });
  const publicationTime = socialEnvelopePayloadSchema.shape.publicationTime
    .parse(candidate.item.publicationTime);
  const content = socialEnvelopePayloadSchema.shape.content.parse({
    title: candidate.item.title,
    text: '',
    html: '',
    completeness: 'link-only',
  });

  const metadata = {
    schemaVersion: 1,
    sanitizationVersion,
    platform: 'wechat',
    publisherIdentity: policy.source.publisherIdentity,
    item,
    publicationTime,
    content,
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8');
  const rawBlob = {
    blob: {
      sha256: createHash('sha256').update(metadataBytes).digest('hex'),
      contentType: 'application/json; charset=utf-8',
      byteLength: metadataBytes.byteLength,
    },
    sourceUrl: item.canonicalUrl,
    acquiredAt: candidate.provenance.acquiredAt,
    evidenceTier: 'public-safe' as const,
    evidenceKind: 'provider-export' as const,
    sanitizationVersion,
  };
  const payload: SocialEnvelopePayload = {
    source: policy.source,
    item,
    publicationTime,
    content,
    media: [],
    attachments: [],
    attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
    rawBlobs: [rawBlob],
  };
  const envelope = {
    schemaVersion: 1 as const,
    payload,
    provenance: {
      acquiredAt: candidate.provenance.acquiredAt,
      method: 'credentialed-public-export' as const,
      provider: {
        name: candidate.provenance.provider.name,
        version: candidate.provenance.provider.version,
      },
      exporter: candidate.provenance.exporter,
      runId,
    },
    decision: {
      status: 'review-required' as const,
      mode: 'none' as const,
      method: 'item-review' as const,
      policyVersion: policy.source.policyVersion,
      decidedAt: now.toISOString(),
      reason: reviewReason,
      binding: socialPublicationBinding(payload),
    },
  };

  return {
    bundle: parseSocialAcquisitionBundle({
      schemaVersion: 1,
      bundleId: `wechat-weread-shadow-v1:${runId}`,
      envelopes: [envelope],
    }),
    metadataBytes,
  };
}
