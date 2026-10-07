import { createHash } from 'node:crypto';
import {
  socialEnvelopePayloadSchema,
  socialItemIdentitySchema,
  socialPublisherIdentitySchema,
  socialSourceItemId,
  type SocialEnvelopePayload,
} from '@nju-info/core';
import { z } from 'zod';

const timestampSchema = z.iso.datetime({ offset: true });
const decimalId = z.string().regex(/^[1-9]\d*$/);
const canonicalBase64 = z.string().min(4).refine((value) => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}, 'expected canonical padded base64');

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !value.includes('#');
}, 'expected credential-free HTTPS URL');

const coverUrlSchema = httpsUrl.refine(
  (value) => new URL(value).hostname === 'mmbiz.qpic.cn',
  'expected WeChat image CDN URL',
);

const unixSecondsSchema = decimalId.refine((value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 253402300799;
});

export const wereadLatestExportSchema = z.object({
  schemaVersion: z.literal(2),
  acquiredAt: timestampSchema,
  provider: z.object({
    name: z.literal('WeRSS'),
    version: z.string().min(1),
    mode: z.literal('weread_mp'),
  }).strict(),
  feed: z.object({
    id: z.string().regex(/^MP_WXS_[1-9]\d*$/),
    name: z.string().min(1),
    fakerId: canonicalBase64,
  }).strict(),
  latest: z.object({
    reviewId: z.string().min(1),
    title: z.string().min(1),
    coverUrl: coverUrlSchema,
    contentHtml: z.string(),
    canonicalBiz: canonicalBase64,
    mid: decimalId,
    idx: z.number().int().positive(),
    sn: z.string().min(8).regex(/^[A-Za-z0-9_-]+$/),
    publicationUnixSeconds: unixSecondsSchema,
  }).strict(),
}).strict();

export type WereadLatestExport = z.infer<typeof wereadLatestExportSchema>;

export interface WereadLatestCandidate {
  schemaVersion: 2;
  platform: 'wechat';
  shadowItemId: string;
  publicationEligible: false;
  bundleIdentityEligible: true;
  bundleEligible: false;
  source: {
    displayName: string;
    providerFeedId: string;
    providerFakerId: string;
    decodedBookId: string;
    publisherIdentity: {
      scheme: 'wechat-biz';
      version: 1;
      value: string;
    };
  };
  item: {
    providerReviewId: string;
    nativeIdentity: {
      scheme: 'wechat-mid-idx';
      version: 1;
      mid: string;
      idx: number;
    };
    sourceItemId: string;
    originalUrl: string;
    canonicalUrl: string;
    title: string;
    coverUrl: string;
    publicationTime: SocialEnvelopePayload['publicationTime'];
    content: {
      sha256: string;
      contentType: 'text/html; charset=utf-8';
      byteLength: number;
      sanitization: 'none-restricted';
    };
  };
  identityQualification: {
    publisher: {
      evidence: 'feed-fakerId-equals-content-og-biz';
      status: 'verified';
    };
    item: {
      evidence: 'content-og-url-mid-idx';
      status: 'complete';
    };
  };
  discovery: {
    complete: false;
    reason: 'weread-cover-latest-only';
  };
  provenance: {
    acquiredAt: string;
    method: 'credentialed-public-export';
    provider: {
      name: 'WeRSS';
      version: string;
      mode: 'weread_mp';
    };
    exporter: {
      name: '@nju-info/wechat-weread-acquire';
      version: '0.0.0';
    };
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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

export function normalizeWereadLatest(input: unknown): WereadLatestCandidate {
  const parsed = wereadLatestExportSchema.parse(input);
  const bookId = parsed.feed.id.slice('MP_WXS_'.length);
  const decoded = Buffer.from(parsed.feed.fakerId, 'base64').toString('utf8');
  if (!/^[1-9]\d*$/.test(decoded) || decoded !== bookId) {
    throw new Error('WeRead feed/faker publisher identity mismatch');
  }
  if (parsed.latest.canonicalBiz !== parsed.feed.fakerId) {
    throw new Error('WeRead content-page __biz does not match provider fakerId');
  }

  const reviewPrefix = `${parsed.feed.id}_`;
  if (!parsed.latest.reviewId.startsWith(reviewPrefix)) {
    throw new Error('WeRead review identity does not belong to configured feed');
  }
  const articleToken = parsed.latest.reviewId.slice(reviewPrefix.length);
  if (!/^[A-Za-z0-9_~+\-]{8,}$/.test(articleToken)) {
    throw new Error('Invalid WeRead article token');
  }

  const publisherIdentity = socialPublisherIdentitySchema.parse({
    scheme: 'wechat-biz', version: 1, value: parsed.latest.canonicalBiz,
  });
  if (publisherIdentity.scheme !== 'wechat-biz') throw new Error('Invalid WeChat publisher identity');
  const nativeIdentity = socialItemIdentitySchema.parse({
    scheme: 'wechat-mid-idx', version: 1, mid: parsed.latest.mid, idx: parsed.latest.idx,
  });
  if (nativeIdentity.scheme !== 'wechat-mid-idx') throw new Error('Invalid WeChat article identity');

  const originalUrl = `https://mp.weixin.qq.com/s/${encodeURIComponent(articleToken)}`;
  const canonical = new URL('https://mp.weixin.qq.com/s');
  canonical.searchParams.set('__biz', publisherIdentity.value);
  canonical.searchParams.set('mid', nativeIdentity.mid);
  canonical.searchParams.set('idx', String(nativeIdentity.idx));
  canonical.searchParams.set('sn', parsed.latest.sn);

  const unixSeconds = Number(parsed.latest.publicationUnixSeconds);
  const unixMilliseconds = unixSeconds * 1000;
  const normalizedAt = new Date(unixMilliseconds).toISOString();
  const publicationTime = socialEnvelopePayloadSchema.shape.publicationTime.parse({
    original: { value: parsed.latest.publicationUnixSeconds, representation: 'unix-seconds' },
    precision: 'second',
    timezone: 'Asia/Shanghai',
    normalizedAt,
    publishedOn: shanghaiCalendarDate(unixMilliseconds),
  });

  const contentBytes = Buffer.from(parsed.latest.contentHtml, 'utf8');
  const sourceItemId = socialSourceItemId({
    platform: 'wechat', publisher: publisherIdentity, item: nativeIdentity,
  });
  const shadowItemId = `wechat-weread-review-v1:${sha256(`${parsed.feed.id}\0${parsed.latest.reviewId}`)}`;

  return {
    schemaVersion: 2,
    platform: 'wechat',
    shadowItemId,
    publicationEligible: false,
    bundleIdentityEligible: true,
    bundleEligible: false,
    source: {
      displayName: parsed.feed.name,
      providerFeedId: parsed.feed.id,
      providerFakerId: parsed.feed.fakerId,
      decodedBookId: decoded,
      publisherIdentity,
    },
    item: {
      providerReviewId: parsed.latest.reviewId,
      nativeIdentity,
      sourceItemId,
      originalUrl,
      canonicalUrl: canonical.toString(),
      title: parsed.latest.title,
      coverUrl: parsed.latest.coverUrl,
      publicationTime,
      content: {
        sha256: sha256(contentBytes),
        contentType: 'text/html; charset=utf-8',
        byteLength: contentBytes.byteLength,
        sanitization: 'none-restricted',
      },
    },
    identityQualification: {
      publisher: { evidence: 'feed-fakerId-equals-content-og-biz', status: 'verified' },
      item: { evidence: 'content-og-url-mid-idx', status: 'complete' },
    },
    discovery: { complete: false, reason: 'weread-cover-latest-only' },
    provenance: {
      acquiredAt: parsed.acquiredAt,
      method: 'credentialed-public-export',
      provider: parsed.provider,
      exporter: { name: '@nju-info/wechat-weread-acquire', version: '0.0.0' },
    },
  };
}
