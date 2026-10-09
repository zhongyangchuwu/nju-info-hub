import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { parseSocialAcquisitionBundle, socialEnvelopePayloadSchema, type SocialEnvelopePayload } from './social-acquisition.js';
import { normalizePublicationDate } from './publication-date.js';
import { parseSocialImportJson, socialImportLimits } from './social-import-json.js';
import type {
  SignedSocialImportOperation, SocialImportInput, SocialImportOperation, SocialImportTrust,
  SocialTrustedSource, VerifiedSocialImport,
} from './social-import-types.js';

const { maxItems, maxBundleBytes, maxBlobBytes, maxTotalBlobBytes } = socialImportLimits;
const identifier = z.string().max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonblank = z.string().max(16_384).refine((value) => value.trim().length > 0, 'expected nonblank text');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nativeItemId = z.string().regex(/^social-native-v1:[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)),
  'expected an explicit-offset timestamp without submillisecond precision',
);
const base64 = z.string().max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(
  (value) => Buffer.from(value, 'base64').toString('base64') === value,
  'expected canonical padded base64',
);
const signature = base64.refine((value) => Buffer.from(value, 'base64').length === 64, 'expected Ed25519 signature');

function publicKey(value: string): KeyObject {
  const bytes = Buffer.from(value, 'base64');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' ||
      !key.export({ format: 'der', type: 'spki' }).equals(bytes)) {
    throw new Error('Expected canonical public Ed25519 SPKI key');
  }
  return key;
}

const keySchema = z.object({
  id: identifier,
  publicKey: base64.refine((value) => {
    try { publicKey(value); return true; } catch { return false; }
  }, 'expected canonical public Ed25519 SPKI key'),
}).strict();
const homepage = z.url().max(4096).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password &&
    !/[\s\u0000-\u001f\u007f]/.test(value) && !value.includes('#') &&
    !/^https:\/\/[^/?#]*@/i.test(value) && url.search === '';
}, 'expected credential-free HTTPS homepage');
const sourceSchema = z.object({
  policy: socialEnvelopePayloadSchema.shape.source,
  organization: z.object({ id: identifier, name: nonblank }).strict(),
  homepageUrl: homepage,
  qualification: z.object({
    owner: nonblank,
    publicAudienceEvidence: nonblank,
    allowedContentScope: z.literal('link-only'),
    redistributionBasis: nonblank,
    reviewedAt: timestamp,
    reviewUntil: timestamp,
  }).strict(),
  producerIds: z.array(identifier).min(1).max(maxItems),
  approverIds: z.array(identifier).min(1).max(maxItems),
}).strict().superRefine((source, context) => {
  if ((source.policy.platform === 'qzone') !== (source.policy.publisherIdentity.scheme === 'qzone-uin')) {
    context.addIssue({ code: 'custom', path: ['policy', 'publisherIdentity'], message: 'publisher must match platform' });
  }
  if (!source.policy.displayName.trim() || !source.policy.policyVersion.trim()) {
    context.addIssue({ code: 'custom', path: ['policy'], message: 'source labels must be nonblank' });
  }
  if (Date.parse(source.qualification.reviewedAt) >= Date.parse(source.qualification.reviewUntil)) {
    context.addIssue({ code: 'custom', path: ['qualification'], message: 'review must precede review expiry' });
  }
  for (const field of ['producerIds', 'approverIds'] as const) {
    if (new Set(source[field]).size !== source[field].length) {
      context.addIssue({ code: 'custom', path: [field], message: 'allowed key IDs must be unique' });
    }
  }
});
const trustSchema = z.object({
  schemaVersion: z.literal(1),
  producers: z.array(keySchema).max(maxItems),
  approvers: z.array(keySchema).max(maxItems),
  sources: z.array(sourceSchema).max(maxItems),
}).strict().superRefine((trust, context) => {
  const keyIds = new Set<string>();
  const keys = new Set<string>();
  for (const role of ['producers', 'approvers'] as const) {
    trust[role].forEach((key, index) => {
      if (keyIds.has(key.id) || keys.has(key.publicKey)) {
        context.addIssue({ code: 'custom', path: [role, index], message: 'key IDs and public keys must be unique across roles' });
      }
      keyIds.add(key.id);
      keys.add(key.publicKey);
    });
  }
  const sourceIds = new Set<string>();
  const publishers = new Set<string>();
  trust.sources.forEach((source, index) => {
    const publisher = JSON.stringify([source.policy.platform, source.policy.publisherIdentity]);
    if (sourceIds.has(source.policy.sourceId) || publishers.has(publisher)) {
      context.addIssue({ code: 'custom', path: ['sources', index], message: 'source and native publisher registrations must be unique' });
    }
    sourceIds.add(source.policy.sourceId);
    publishers.add(publisher);
    for (const [field, role] of [['producerIds', 'producers'], ['approverIds', 'approvers']] as const) {
      if (source[field].some((id) => !trust[role].some((key) => key.id === id))) {
        context.addIssue({ code: 'custom', path: ['sources', index, field], message: 'source must allow known keys of the correct role' });
      }
    }
  });
});
const receiptSchema = z.object({ sha256: hash, producerId: identifier, signature }).strict();
const operationSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.uuid().refine((value) => value === value.toLowerCase(), 'expected canonical lowercase UUID'),
  sourceId: socialEnvelopePayloadSchema.shape.source.shape.sourceId,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuedAt: timestamp,
  expiresAt: timestamp,
  policySha256: hash,
  approverId: identifier,
  action: z.enum(['publish', 'restore', 'suppress', 'revoke-source']),
  bundle: receiptSchema.nullable(),
  sourceItemIds: z.array(nativeItemId).max(maxItems),
  reasonCode: z.enum(['approved-metadata', 'correction', 'withdrawal', 'source-revocation']),
}).strict().superRefine((operation, context) => {
  if (Date.parse(operation.issuedAt) >= Date.parse(operation.expiresAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'approval must precede expiry' });
  }
  const publishing = operation.action === 'publish' || operation.action === 'restore';
  const valid = publishing
    ? operation.bundle !== null && operation.sourceItemIds.length === 0 &&
      (operation.reasonCode === 'approved-metadata' || operation.reasonCode === 'correction')
    : operation.bundle === null && (operation.action === 'suppress'
      ? operation.sourceItemIds.length > 0 && (operation.reasonCode === 'withdrawal' || operation.reasonCode === 'correction')
      : operation.sourceItemIds.length === 0 && operation.reasonCode === 'source-revocation');
  if (!valid || new Set(operation.sourceItemIds).size !== operation.sourceItemIds.length) {
    context.addIssue({ code: 'custom', message: 'invalid action, bundle, identity or reason combination' });
  }
});
const authorizationSchema = z.object({ operation: operationSchema, signature }).strict();

export function parseSocialImportTrust(input: unknown): SocialImportTrust {
  return trustSchema.parse(input);
}

export function parseSocialImportOperation(input: unknown): SocialImportOperation {
  return operationSchema.parse(input);
}

export function parseSignedSocialImportOperation(input: unknown): SignedSocialImportOperation {
  return authorizationSchema.parse(input);
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function socialTrustedSourceSha256(source: SocialTrustedSource): string {
  return sha256(JSON.stringify(sourceSchema.parse(source)));
}

export function socialProducerReceiptBytes(producerId: string, sha256: string): Buffer {
  return Buffer.from(JSON.stringify(['social-producer-bundle', 1, identifier.parse(producerId), hash.parse(sha256)]), 'utf8');
}

export function socialImportOperationBytes(operation: unknown): Buffer {
  return operationBytes(parseSocialImportOperation(operation));
}

function operationBytes(operation: SocialImportOperation): Buffer {
  return Buffer.from(JSON.stringify(['social-import-operation', 1, operation]), 'utf8');
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clock(value: string): number {
  return Date.parse(timestamp.parse(value));
}

/** Positive, version-specific projection: descriptors and provider/private metadata are excluded. */
function metadataBytes(payload: SocialEnvelopePayload, sanitizationVersion: string): Buffer {
  assert(payload.item.aliases.length === 0 && payload.attribution.relationship === 'unknown' &&
    payload.attribution.verification === 'unknown' && payload.attribution.origin === null &&
    payload.attribution.evidence.length === 0, 'Unsupported metadata aliases or attribution');
  const metadata = {
    schemaVersion: 1,
    sanitizationVersion,
    platform: payload.source.platform,
    publisherIdentity: payload.source.publisherIdentity,
    item: payload.item,
    publicationTime: payload.publicationTime,
    content: payload.content,
    ...(payload.source.platform === 'qzone' ? { attribution: payload.attribution } : {}),
  };
  if (payload.source.platform === 'qzone') {
    assert(sanitizationVersion === 'qzone-link-metadata-v1' && payload.item.originalUrl === payload.item.canonicalUrl,
      'Unsupported QZone metadata version or URL');
  } else {
    assert(sanitizationVersion === 'wechat-weread-link-metadata-v1', 'Unsupported WeRead metadata version');
  }
  return Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8');
}

/** Authenticate first; parser declarations never confer approval, rights, or byte safety. */
export function verifySocialImport(input: SocialImportInput, now: Date): VerifiedSocialImport {
  assert(now instanceof Date && Number.isFinite(now.getTime()), 'Invalid verification clock');
  const currentTime = now.getTime();
  const trust = parseSocialImportTrust(input.trust);
  const authorization = parseSignedSocialImportOperation(input.authorization);
  const operation = authorization.operation;
  const source = trust.sources.find((entry) => entry.policy.sourceId === operation.sourceId);
  assert(source !== undefined, 'Untrusted social source');
  const approver = trust.approvers.find((key) => key.id === operation.approverId);
  assert(approver !== undefined && source.approverIds.includes(approver.id), 'Untrusted social approver');
  const reviewedAt = clock(source.qualification.reviewedAt);
  const issuedAt = clock(operation.issuedAt);
  assert(reviewedAt <= currentTime && currentTime < clock(source.qualification.reviewUntil) &&
    reviewedAt <= issuedAt && issuedAt <= currentTime && currentTime < clock(operation.expiresAt),
  'Social qualification or operation is not currently valid');
  assert(socialTrustedSourceSha256(source) === operation.policySha256, 'Social policy fingerprint mismatch');
  const preimage = operationBytes(operation);
  assert(verify(null, preimage, publicKey(approver.publicKey), Buffer.from(authorization.signature, 'base64')),
    'Invalid social operator signature');
  const authorizationBytes = Buffer.from(`${JSON.stringify(authorization)}\n`, 'utf8');
  const result = { operation, operationSha256: sha256(preimage), authorizationBytes, source };
  assert(input.blobs instanceof Map && input.blobs.size <= maxItems, 'Invalid social blob map');
  if (operation.bundle === null) {
    assert(input.bundleBytes === null && input.blobs.size === 0, 'Control operations cannot carry bundle data');
    return { ...result, bundle: null, bundleBytes: null, blobs: new Map() };
  }
  assert(source.policy.redistributionMode !== 'denied', 'Denied policy cannot publish metadata');
  const receipt = operation.bundle;
  const producer = trust.producers.find((key) => key.id === receipt.producerId);
  assert(producer !== undefined && source.producerIds.includes(producer.id), 'Untrusted social producer');
  assert(verify(null, socialProducerReceiptBytes(receipt.producerId, receipt.sha256), publicKey(producer.publicKey),
    Buffer.from(receipt.signature, 'base64')), 'Invalid social producer signature');
  assert(Buffer.isBuffer(input.bundleBytes) && input.bundleBytes.length > 0 && input.bundleBytes.length <= maxBundleBytes,
    'Invalid social bundle size');
  assert(sha256(input.bundleBytes) === receipt.sha256, 'Social bundle hash mismatch');
  const bundle = parseSocialAcquisitionBundle(parseSocialImportJson(input.bundleBytes));
  assert(bundle.envelopes.length <= maxItems, 'Too many social envelopes');
  const nativeIds = new Set<string>();
  const blobs = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const envelope of bundle.envelopes) {
    const { payload, provenance, decision } = envelope;
    assert(JSON.stringify(payload.source) === JSON.stringify(source.policy), 'Social source policy mismatch');
    assert(!nativeIds.has(payload.item.sourceItemId), 'Duplicate social native identity');
    nativeIds.add(payload.item.sourceItemId);
    assert(payload.content.completeness === 'link-only' && payload.content.title !== null &&
      payload.content.title.trim().length > 0 && payload.content.text === '' && payload.content.html === '' &&
      payload.media.length === 0 && payload.attachments.length === 0, 'Only nonblank link metadata is supported');
    assert(decision.status !== 'rejected', 'Rejected producer packet cannot be published');
    assert(decision.status !== 'approved' || decision.mode === 'link-only', 'Unsupported producer publication mode');
    assert((source.policy.role !== 'sentinel' && source.policy.redistributionMode !== 'review-only') ||
      decision.method === 'item-review', 'Source requires item-review metadata');
    const acquiredAt = clock(provenance.acquiredAt);
    const decidedAt = clock(decision.decidedAt);
    assert(acquiredAt <= decidedAt && decidedAt <= issuedAt, 'Social acquisition/decision clock order mismatch');
    const publication = payload.publicationTime;
    if (publication.original !== null && publication.precision !== 'unknown' && publication.precision !== 'day') {
      const original = publication.original;
      const publicationInstant = original.representation === 'unix-seconds' ? Number(original.value) * 1000
        : original.representation === 'unix-milliseconds' ? Number(original.value) : Date.parse(original.value);
      assert(publicationInstant <= acquiredAt, 'Future original social publication time');
    }
    if (payload.publicationTime.normalizedAt !== null) {
      assert(clock(payload.publicationTime.normalizedAt) <= acquiredAt, 'Future social publication time');
    }
    if (publication.precision === 'day' && publication.original !== null) {
      const publicationDay = publication.original.representation === 'iso8601'
        ? publication.original.value : normalizePublicationDate(publication.original.value);
      assert(publicationDay !== null, 'Invalid social publication day');
      const timezone = publication.timezone;
      const offset = timezone === null ? null : /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
      let latestDay: string;
      if (timezone === null || timezone === 'UTC' || timezone === 'Z' || offset !== null) {
        // Unknown timezone admits no invented instant; use the latest possible calendar date.
        const minutes = timezone === null ? 24 * 60 : offset === null ? 0
          : (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
        latestDay = new Date(acquiredAt + minutes * 60_000).toISOString().slice(0, 10);
      } else {
        const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
          .formatToParts(new Date(acquiredAt));
        latestDay = `${parts.find((part) => part.type === 'year')!.value.padStart(4, '0')}-${parts.find((part) => part.type === 'month')!.value}-${parts.find((part) => part.type === 'day')!.value}`;
      }
      assert(publicationDay <= latestDay, 'Future social publication day');
    }
    assert(payload.rawBlobs.length === 1, 'Exactly one metadata raw blob is required');
    const raw = payload.rawBlobs[0]!;
    assert(raw.evidenceKind === 'provider-export' && raw.evidenceTier === 'public-safe' &&
      raw.sourceUrl === payload.item.canonicalUrl && clock(raw.acquiredAt) === acquiredAt,
    'Metadata raw provenance mismatch');
    const bytes = input.blobs.get(raw.blob.sha256);
    assert(Buffer.isBuffer(bytes) && bytes.length <= maxBlobBytes && bytes.length === raw.blob.byteLength &&
      raw.blob.contentType === 'application/json; charset=utf-8' && sha256(bytes) === raw.blob.sha256,
    'Metadata blob descriptor or hash mismatch');
    assert(bytes.equals(metadataBytes(payload, raw.sanitizationVersion)), 'Metadata positive projection mismatch');
    if (!blobs.has(raw.blob.sha256)) {
      totalBytes += bytes.length;
      assert(totalBytes <= maxTotalBlobBytes, 'Social metadata total size exceeded');
      blobs.set(raw.blob.sha256, bytes);
    }
  }
  assert(input.blobs.size === blobs.size, 'Surplus social blobs');
  return { ...result, bundle, bundleBytes: input.bundleBytes, blobs };
}
