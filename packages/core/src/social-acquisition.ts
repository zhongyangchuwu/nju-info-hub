import { createHash } from 'node:crypto';
import { z } from 'zod';
import { socialItemIdentitySchema, socialPublisherIdentitySchema, socialSourceItemId } from './social-identity.js';
import { socialPublicationTimeSchema } from './social-publication-time.js';

const nonEmptyString = z.string().min(1);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase SHA-256');
const timestampSchema = z.iso.datetime({ offset: true });
type UrlPurpose = 'publication' | 'asset' | 'attribution';
const urlQueryKeys: Record<UrlPurpose, Record<string, true>> = {
  publication: {
    __biz: true, mid: true, idx: true, sn: true, uin: true, tid: true,
    id: true, type: true, category: true, channel: true, page: true, articleId: true, newsId: true,
  },
  asset: {
    id: true, type: true, wx_fmt: true, w: true, h: true, width: true, height: true,
    size: true, format: true, quality: true, q: true, resize: true, crop: true, fit: true,
    download: true, filename: true,
  },
  attribution: {
    __biz: true, mid: true, idx: true, sn: true, uin: true, tid: true,
    id: true, type: true, category: true, channel: true, page: true, articleId: true, newsId: true,
    article: true, post: true, notice: true,
  },
};

function socialUrlSchema(purpose: UrlPurpose) {
  return z.url().refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (/[\s\u0000-\u001f\u007f]/.test(value) || url.protocol !== 'https:' ||
        url.username || url.password || value.includes('#') || /^https:\/\/[^/?#]*@/i.test(value)) return false;
    return [...url.searchParams.keys()].every((key) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      return !/(auth|token|session|cookie|password|passwd|credential|secret|ticket|skey|jwt|apikey|signature|tracking|referrer|openid|unionid|wxfrom|utm)/.test(normalized) &&
        Object.hasOwn(urlQueryKeys[purpose], key);
    });
  }, `expected credential-free HTTPS ${purpose} URL with approved routing parameters`);
}

const publicationUrlSchema = socialUrlSchema('publication');
const assetUrlSchema = socialUrlSchema('asset');
const attributionUrlSchema = socialUrlSchema('attribution');

const sourcePolicySchema = z.object({
  sourceId: z.string().min(3).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  platform: z.enum(['wechat', 'qzone']),
  publisherIdentity: socialPublisherIdentitySchema,
  displayName: nonEmptyString,
  role: z.enum(['official', 'relay', 'sentinel']),
  access: z.enum(['anonymous', 'credentialed-public']),
  audience: z.literal('public'),
  redistributionMode: z.enum(['full', 'summary', 'link-only', 'review-only', 'denied']),
  policyVersion: nonEmptyString,
}).strict().superRefine((source, context) => {
  if (source.role === 'sentinel' && source.redistributionMode !== 'review-only' && source.redistributionMode !== 'denied') {
    context.addIssue({ code: 'custom', path: ['redistributionMode'], message: 'sentinel policies must be review-only or denied' });
  }
});

const itemSchema = z.object({
  nativeIdentity: socialItemIdentitySchema,
  sourceItemId: z.string().regex(/^social-native-v1:[a-f0-9]{64}$/),
  originalUrl: publicationUrlSchema,
  canonicalUrl: publicationUrlSchema,
  aliases: z.array(publicationUrlSchema),
}).strict();

const blobSchema = z.object({
  sha256: sha256Schema,
  contentType: nonEmptyString,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const assetSchema = z.object({
  position: z.number().int().nonnegative(),
  kind: z.enum(['image', 'video', 'audio', 'file']),
  title: z.string(),
  originalUrl: assetUrlSchema.nullable(),
  acquisitionStatus: z.enum(['captured', 'unavailable', 'not-requested']),
  blob: blobSchema.nullable(),
}).strict().superRefine((asset, context) => {
  if ((asset.acquisitionStatus === 'captured') !== (asset.blob !== null)) {
    context.addIssue({ code: 'custom', path: ['blob'], message: 'only captured assets have a blob' });
  }
});

const rawBlobSchema = z.object({
  blob: blobSchema,
  sourceUrl: publicationUrlSchema,
  acquiredAt: timestampSchema,
  evidenceTier: z.literal('public-safe'),
  evidenceKind: z.enum(['origin-response', 'provider-export', 'screenshot']),
  sanitizationVersion: nonEmptyString,
}).strict();

const attributionSchema = z.object({
  relationship: z.enum(['original', 'relay', 'unknown']),
  verification: z.enum(['verified', 'reported', 'unknown']),
  origin: z.object({
    publisherName: nonEmptyString,
    publisherId: nonEmptyString.nullable(),
    nativeItemId: nonEmptyString.nullable(),
    url: attributionUrlSchema.nullable(),
  }).strict().nullable(),
  evidence: z.array(z.object({
    kind: z.enum(['publisher-statement', 'original-link', 'screenshot', 'operator-review']),
    description: nonEmptyString,
    url: attributionUrlSchema.nullable(),
    blobSha256: sha256Schema.nullable(),
  }).strict()),
}).strict();

function validateBlobManifest(
  payload: {
    rawBlobs: z.infer<typeof rawBlobSchema>[];
    media: z.infer<typeof assetSchema>[];
    attachments: z.infer<typeof assetSchema>[];
  },
  context: z.RefinementCtx,
  manifest = new Map<string, z.infer<typeof blobSchema>>(),
  envelopeIndex?: number,
) {
  for (const surface of ['rawBlobs', 'media', 'attachments'] as const) {
    payload[surface].forEach((reference, index) => {
      if ('acquisitionStatus' in reference && reference.acquisitionStatus !== 'captured') return;
      const blob = reference.blob;
      if (blob === null) return;
      const previous = manifest.get(blob.sha256);
      if (previous === undefined) {
        manifest.set(blob.sha256, blob);
        return;
      }
      for (const field of ['byteLength', 'contentType'] as const) {
        if (blob[field] !== previous[field]) {
          context.addIssue({
            code: 'custom',
            path: envelopeIndex === undefined
              ? [surface, index, 'blob', field]
              : ['envelopes', envelopeIndex, 'payload', surface, index, 'blob', field],
            message: `descriptors for the same SHA-256 must agree on ${field}`,
          });
        }
      }
    });
  }
  return manifest;
}

/** Safe declarations only: parsing cannot certify HTML, images, audience, or rights. */
export const socialEnvelopePayloadSchema = z.object({
  source: sourcePolicySchema,
  item: itemSchema,
  publicationTime: socialPublicationTimeSchema,
  content: z.object({
    title: nonEmptyString.nullable(),
    text: z.string(),
    html: z.string(),
    completeness: z.enum(['full', 'partial', 'image-only', 'link-only']),
  }).strict(),
  media: z.array(assetSchema),
  attachments: z.array(assetSchema),
  attribution: attributionSchema,
  rawBlobs: z.array(rawBlobSchema).min(1),
}).strict().superRefine((payload, context) => {
  try {
    const expectedId = socialSourceItemId({
      platform: payload.source.platform,
      publisher: payload.source.publisherIdentity,
      item: payload.item.nativeIdentity,
    });
    if (payload.item.sourceItemId !== expectedId) {
      context.addIssue({ code: 'custom', path: ['item', 'sourceItemId'], message: 'native identity mismatch' });
    }
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    context.addIssue({ code: 'custom', path: ['item', 'sourceItemId'], message: 'invalid native identity' });
  }
  const declaredBlobs = validateBlobManifest(payload, context);
  for (const key of ['media', 'attachments'] as const) {
    payload[key].forEach((asset, index) => {
      if (asset.position !== index) {
        context.addIssue({ code: 'custom', path: [key, index, 'position'], message: 'positions must follow array order' });
      }
    });
  }
  payload.attribution.evidence.forEach((evidence, index) => {
    if (evidence.blobSha256 !== null && !declaredBlobs.has(evidence.blobSha256)) {
      context.addIssue({ code: 'custom', path: ['attribution', 'evidence', index, 'blobSha256'], message: 'attribution evidence must reference a declared public-safe blob' });
    }
  });
  if (payload.content.completeness === 'link-only' && (payload.content.text !== '' ||
      payload.content.html !== '' || payload.media.length > 0 || payload.attachments.length > 0)) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'link-only content cannot include bodies or assets' });
  }
  if (payload.content.completeness === 'image-only' &&
      !payload.media.some((asset) => asset.kind === 'image' && asset.acquisitionStatus === 'captured')) {
    context.addIssue({ code: 'custom', path: ['media'], message: 'image-only content needs a captured image' });
  }
  if (payload.content.completeness === 'full' &&
      [...payload.media, ...payload.attachments].some((asset) => asset.acquisitionStatus !== 'captured')) {
    context.addIssue({ code: 'custom', path: ['content', 'completeness'], message: 'missing assets require partial content' });
  }
});

export type SocialEnvelopePayload = z.infer<typeof socialEnvelopePayloadSchema>;

const bindingSchema = z.object({
  payloadSha256: sha256Schema,
  mediaSha256s: z.array(sha256Schema),
}).strict();

function bindingFromParsedPayload(payload: SocialEnvelopePayload): z.infer<typeof bindingSchema> {
  return {
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    mediaSha256s: [...payload.media, ...payload.attachments]
      .flatMap((asset) => asset.blob === null ? [] : [asset.blob.sha256]),
  };
}

/** Schema key order is canonical; media/attachment arrays retain their declared order. */
export function socialPublicationBinding(payload: SocialEnvelopePayload): z.infer<typeof bindingSchema> {
  return bindingFromParsedPayload(socialEnvelopePayloadSchema.parse(payload));
}

const decisionSchema = z.object({
  status: z.enum(['approved', 'review-required', 'rejected']),
  mode: z.enum(['full', 'summary', 'link-only', 'none']),
  method: z.enum(['source-policy', 'item-review']),
  policyVersion: nonEmptyString,
  decidedAt: timestampSchema,
  reason: nonEmptyString,
  binding: bindingSchema,
}).strict();

const allowedPublicationModes: Record<
  SocialEnvelopePayload['source']['redistributionMode'],
  ReadonlyArray<z.infer<typeof decisionSchema>['mode']>
> = {
  full: ['full', 'summary', 'link-only'],
  summary: ['summary', 'link-only'],
  'link-only': ['link-only'],
  'review-only': ['full', 'summary', 'link-only'],
  denied: [],
};

const implementationSchema = z.object({ name: nonEmptyString, version: nonEmptyString }).strict();

export const socialAcquisitionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  payload: socialEnvelopePayloadSchema,
  provenance: z.object({
    acquiredAt: timestampSchema,
    method: z.enum(['anonymous-fetch', 'credentialed-public-export', 'manual-public-capture']),
    provider: implementationSchema,
    exporter: implementationSchema,
    runId: nonEmptyString,
  }).strict(),
  decision: decisionSchema,
}).strict().superRefine((envelope, context) => {
  const { payload, provenance, decision } = envelope;
  const expected = bindingFromParsedPayload(payload);
  if (decision.binding.payloadSha256 !== expected.payloadSha256 ||
      JSON.stringify(decision.binding.mediaSha256s) !== JSON.stringify(expected.mediaSha256s)) {
    context.addIssue({ code: 'custom', path: ['decision', 'binding'], message: 'decision must bind the exact payload and ordered captured asset hashes' });
  }
  if (decision.policyVersion !== payload.source.policyVersion) {
    context.addIssue({ code: 'custom', path: ['decision', 'policyVersion'], message: 'decision policy version mismatch' });
  }
  if (provenance.method === 'anonymous-fetch' && payload.source.access !== 'anonymous') {
    context.addIssue({ code: 'custom', path: ['provenance', 'method'], message: 'anonymous acquisition cannot claim a credentialed-public source' });
  }
  if (decision.status !== 'approved' && decision.mode !== 'none') {
    context.addIssue({ code: 'custom', path: ['decision', 'mode'], message: 'unapproved decisions cannot authorize publication' });
  }
  if (decision.status === 'approved') {
    if (!allowedPublicationModes[payload.source.redistributionMode].includes(decision.mode)) {
      context.addIssue({ code: 'custom', path: ['decision', 'mode'], message: 'publication exceeds source redistribution policy' });
    }
    if ((payload.source.role === 'sentinel' || payload.source.redistributionMode === 'review-only') && decision.method !== 'item-review') {
      context.addIssue({ code: 'custom', path: ['decision', 'method'], message: 'sentinel and review-only sources require item review' });
    }
    if (decision.mode === 'link-only' && payload.content.completeness !== 'link-only') {
      context.addIssue({ code: 'custom', path: ['payload', 'content'], message: 'link-only approval requires link-only payload' });
    }
  }
});

export const socialAcquisitionBundleSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: nonEmptyString,
  envelopes: z.array(socialAcquisitionEnvelopeSchema).min(1),
}).strict().superRefine((bundle, context) => {
  const manifest = new Map<string, z.infer<typeof blobSchema>>();
  bundle.envelopes.forEach((envelope, index) => {
    validateBlobManifest(envelope.payload, context, manifest, index);
  });
});

export type SocialAcquisitionEnvelope = z.infer<typeof socialAcquisitionEnvelopeSchema>;
export type SocialAcquisitionBundle = z.infer<typeof socialAcquisitionBundleSchema>;

export function parseSocialAcquisitionBundle(input: unknown): SocialAcquisitionBundle {
  return socialAcquisitionBundleSchema.parse(input);
}
