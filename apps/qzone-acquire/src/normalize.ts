import {
  socialEnvelopePayloadSchema,
  socialItemIdentitySchema,
  socialPublisherIdentitySchema,
  socialSourceItemId,
  type SocialEnvelopePayload,
} from '@nju-info/core';
import { z } from 'zod';

export interface QzonePost {
  uin: string;
  tid: string;
  created_at: number;
  content: string;
  /** Exact extracted provider URLs, before candidate locator normalization. */
  mediaUrls: string[];
}

export interface QzoneCandidate {
  sourceItemId: string;
  publisherIdentity: {
    scheme: 'qzone-uin';
    version: 1;
    value: string;
  };
  nativeIdentity: {
    scheme: 'qzone-tid';
    version: 1;
    tid: string;
  };
  originalUrl: string;
  publicationTime: SocialEnvelopePayload['publicationTime'];
  content: {
    text: string;
    html: '';
    completeness: 'partial';
  };
  media: Array<{
    position: number;
    /** Validated HTTPS locator; restricted evidence retains the provider URL. */
    originalUrl: string;
    acquisitionStatus: 'not-requested';
  }>;
  attribution: {
    relationship: 'unknown';
    verification: 'unknown';
    origin: null;
    evidence: [];
  };
}

const postError = 'Invalid QZone post.';
const candidateError = 'Invalid QZone candidate.';
const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger);
const maxUnixSeconds = 253402300799;
const upstreamPostSchema = z.object({
  id: z.string().min(1),
  author: z.object({ uin: positiveSafeInteger }),
  created_at: positiveSafeInteger.refine((value) => value <= maxUnixSeconds),
  content: z.string(),
  images: z.array(z.string()),
});
const qzonePublicationUrlSchema = socialEnvelopePayloadSchema.shape.item.shape.originalUrl;
const qzoneAssetUrlSchema = socialEnvelopePayloadSchema.shape.media.element.shape.originalUrl;

// Only this qualified photo-store family permits an HTTP scheme upgrade.
const qqPhotoStoreHttp = /^http:\/\/(?=[^/?#]{1,253}(?:[/?#]|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*photo\.store\.qq\.com(?=\/|\?|$)/i;
const httpsAssetSyntax = /^https:\/\/[^/?#\\\s]+(?:[/?#]|$)/i;
const malformedPercentEscape = /%(?![a-f0-9]{2})/i;
const invalidAssetCharacters = /[\s\u0000-\u001f\u007f\\]/;

function canonicalQzoneMediaUrl(providerUrl: string): string | null {
  const canonicalUrl = qqPhotoStoreHttp.test(providerUrl) ? `https:${providerUrl.slice(5)}` : providerUrl;
  if (!httpsAssetSyntax.test(canonicalUrl) || invalidAssetCharacters.test(canonicalUrl) || malformedPercentEscape.test(canonicalUrl)) return null;
  const parsed = qzoneAssetUrlSchema.safeParse(canonicalUrl);
  return parsed.success ? parsed.data : null;
}

/** Positively projects the upstream post fields allowed into restricted evidence. */
export function projectQzonePost(input: unknown, expectedUin: string, expectedId?: string): QzonePost {
  const parsed = upstreamPostSchema.safeParse(input);
  const expectedPublisher = socialPublisherIdentitySchema.safeParse({
    scheme: 'qzone-uin', version: 1, value: expectedUin,
  });
  if (!parsed.success || !expectedPublisher.success) throw new Error(postError);

  const { id, author, created_at, content, images } = parsed.data;
  const uin = String(author.uin);
  const separator = id.indexOf(':');
  if (separator < 1) throw new Error(postError);
  const idUin = id.slice(0, separator);
  const tid = id.slice(separator + 1);
  const validIdentity = socialItemIdentitySchema.safeParse({ scheme: 'qzone-tid', version: 1, tid });
  if (idUin !== uin || uin !== expectedPublisher.data.value || !validIdentity.success ||
      (expectedId !== undefined && id !== expectedId)) throw new Error(postError);

  for (const image of images) {
    if (canonicalQzoneMediaUrl(image) === null) throw new Error(postError);
  }

  return { uin, tid, created_at, content, mediaUrls: images };
}

function shanghaiCalendarDate(unixMilliseconds: number): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(unixMilliseconds);
  const year = parts.find((part) => part.type === 'year')!.value.padStart(4, '0');
  const month = parts.find((part) => part.type === 'month')!.value;
  const day = parts.find((part) => part.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

/** Builds a restricted candidate; this is not a public-safe payload or approval. */
export function normalizeQzonePost(post: QzonePost): QzoneCandidate {
  try {
    const publisherIdentity = { scheme: 'qzone-uin', version: 1, value: post.uin } as const;
    socialPublisherIdentitySchema.parse(publisherIdentity);
    const nativeIdentity = { scheme: 'qzone-tid', version: 1, tid: post.tid } as const;
    socialItemIdentitySchema.parse(nativeIdentity);
    const timestamp = positiveSafeInteger.parse(post.created_at);
    if (timestamp > maxUnixSeconds) throw new Error();

    const originalUrl = qzonePublicationUrlSchema.parse(
      `https://user.qzone.qq.com/${publisherIdentity.value}/mood/${encodeURIComponent(nativeIdentity.tid)}`,
    );
    const unixMilliseconds = timestamp * 1000;
    const normalizedAt = new Date(unixMilliseconds).toISOString();
    const publicationTime = socialEnvelopePayloadSchema.shape.publicationTime.parse({
      original: { value: String(timestamp), representation: 'unix-seconds' },
      precision: 'second',
      timezone: 'Asia/Shanghai',
      normalizedAt,
      publishedOn: shanghaiCalendarDate(unixMilliseconds),
    });
    const media = post.mediaUrls.map((originalUrl, position) => {
      const validatedUrl = canonicalQzoneMediaUrl(originalUrl);
      if (validatedUrl === null) throw new Error();
      return { position, originalUrl: validatedUrl, acquisitionStatus: 'not-requested' as const };
    });

    return {
      sourceItemId: socialSourceItemId({ platform: 'qzone', publisher: publisherIdentity, item: nativeIdentity }),
      publisherIdentity,
      nativeIdentity,
      originalUrl,
      publicationTime,
      content: { text: post.content, html: '', completeness: 'partial' },
      media,
      attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
    };
  } catch {
    throw new Error(candidateError);
  }
}
