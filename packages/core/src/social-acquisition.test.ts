import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseSocialAcquisitionBundle,
  socialAcquisitionBundleSchema,
  socialAcquisitionEnvelopeSchema,
  socialEnvelopePayloadSchema,
  socialPublicationBinding,
  socialSourceItemId,
  socialNativeIdentitySchema,
  wechatArticleIdentity,
  type SocialAcquisitionEnvelope,
  type SocialAcquisitionBundle,
  type SocialEnvelopePayload,
} from './index.js';

const identity = {
  platform: 'wechat',
  publisher: { scheme: 'wechat-biz', version: 1, value: Buffer.from('synthetic-publisher').toString('base64') },
  item: { scheme: 'wechat-mid-idx', version: 1, mid: '1001', idx: 1 },
} as const;
const rawBytes = '<p>Synthetic public service notice</p>';
function fixtureBlob(body: string, contentType: string) {
  return { sha256: createHash('sha256').update(body).digest('hex'), contentType, byteLength: Buffer.byteLength(body) };
}
const rawBlob = fixtureBlob(rawBytes, 'text/html; charset=utf-8');
const imageBlob = fixtureBlob('synthetic image bytes', 'image/png');
const pdfBlob = fixtureBlob('synthetic PDF bytes', 'application/pdf');
const officialPayload: SocialEnvelopePayload = {
  source: {
    sourceId: 'example-logistics-wechat',
    platform: identity.platform,
    publisherIdentity: identity.publisher,
    displayName: '示例后勤公众号',
    role: 'official',
    access: 'credentialed-public',
    audience: 'public',
    redistributionMode: 'full',
    policyVersion: 'policy-1',
  },
  item: {
    nativeIdentity: identity.item,
    sourceItemId: socialSourceItemId(identity),
    originalUrl: 'https://public.example/notices/1',
    canonicalUrl: 'https://public.example/notices/1',
    aliases: ['https://mp.weixin.qq.com/s/example-message?mid=1&idx=1'],
  },
  publicationTime: {
    original: { value: '2026-09-29T08:30:00+08:00', representation: 'iso8601' },
    precision: 'second',
    timezone: 'Asia/Shanghai',
    normalizedAt: '2026-09-29T08:30:00+08:00',
    publishedOn: '2026-09-29',
  },
  content: { title: '示例服务时间调整', text: '示例：服务时间调整为09:00。', html: '<p>示例：服务时间调整为09:00。</p>', completeness: 'full' },
  media: [],
  attachments: [],
  attribution: { relationship: 'original', verification: 'verified', origin: null, evidence: [] },
  rawBlobs: [{
    blob: rawBlob,
    sourceUrl: 'https://public.example/notices/1',
    acquiredAt: '2026-09-29T01:00:00Z',
    evidenceTier: 'public-safe',
    evidenceKind: 'provider-export',
    sanitizationVersion: 'sanitation-1',
  }],
};

function envelope(payload = structuredClone(officialPayload)): SocialAcquisitionEnvelope {
  return {
    schemaVersion: 1,
    payload,
    provenance: {
      acquiredAt: '2026-09-29T01:00:00Z',
      method: 'credentialed-public-export',
      provider: { name: 'example-provider', version: '1.0' },
      exporter: { name: 'example-exporter', version: '1.0' },
      runId: 'example-run-1',
    },
    decision: {
      status: 'approved', mode: 'full', method: 'source-policy', policyVersion: 'policy-1',
      decidedAt: '2026-09-29T01:01:00Z', reason: 'Synthetic fixture approval',
      binding: socialPublicationBinding(payload),
    },
  };
}

function sharedBlobPayload(): SocialEnvelopePayload {
  const payload = structuredClone(officialPayload);
  payload.rawBlobs[0]!.blob = { ...imageBlob };
  payload.rawBlobs[0]!.evidenceKind = 'screenshot';
  payload.media = [{ position: 0, kind: 'image', title: 'Shared screenshot', originalUrl: null, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
  payload.attachments = [{ position: 0, kind: 'file', title: 'Same screenshot download', originalUrl: null, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
  return payload;
}

function sharedBlobBundle(): SocialAcquisitionBundle {
  const second = structuredClone(officialPayload);
  second.item.nativeIdentity = { ...identity.item, idx: 2 };
  second.item.sourceItemId = socialSourceItemId({ ...identity, item: second.item.nativeIdentity });
  second.media = [{ position: 0, kind: 'image', title: 'Shared screenshot', originalUrl: null, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
  return { schemaVersion: 1, bundleId: 'synthetic-shared-blob-bundle', envelopes: [envelope(sharedBlobPayload()), envelope(second)] };
}

describe('sanitized social acquisition version 1', () => {
  it('preserves an official envelope and exact original publication representation', () => {
    const input = { schemaVersion: 1, bundleId: 'example-bundle-1', envelopes: [envelope()] };
    const parsed = parseSocialAcquisitionBundle(input);
    expect(parsed).toEqual(input);
    expect(parsed.envelopes[0]?.payload.publicationTime).toEqual(officialPayload.publicationTime);
    expect(parsed.envelopes[0]?.payload.rawBlobs[0]).toMatchObject({ evidenceTier: 'public-safe', blob: rawBlob });
  });

  it('retains relay origin evidence without promoting the relay to official', () => {
    const payload = structuredClone(officialPayload);
    payload.source = { ...payload.source, sourceId: 'example-helper-qzone', platform: 'qzone', publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '123456789' }, displayName: '示例助手', role: 'relay', redistributionMode: 'summary' };
    payload.item.nativeIdentity = { scheme: 'qzone-tid', version: 1, tid: 'synthetic-tid-1' };
    payload.item.sourceItemId = socialSourceItemId({ platform: 'qzone', publisher: payload.source.publisherIdentity, item: payload.item.nativeIdentity });
    payload.attribution = {
      relationship: 'relay', verification: 'reported',
      origin: { publisherName: '示例服务部门', publisherId: null, nativeItemId: null, url: 'https://public.example/original/1' },
      evidence: [{ kind: 'original-link', description: 'Synthetic original attribution', url: 'https://public.example/original/1', blobSha256: null }],
    };
    const input = envelope(payload);
    input.decision.mode = 'summary';
    input.decision.method = 'item-review';
    const parsed = socialAcquisitionEnvelopeSchema.parse(input);
    expect(parsed.payload.source.role).toBe('relay');
    expect(parsed.payload.attribution).toEqual(payload.attribution);
  });

  it('preserves ordered image-heavy sentinel content and attachment hashes', () => {
    const payload = structuredClone(officialPayload);
    payload.source.role = 'sentinel';
    payload.source.redistributionMode = 'review-only';
    payload.content = { title: '示例图片通知', text: '', html: '', completeness: 'image-only' };
    payload.media = [0, 1].map((position) => ({
      position, kind: 'image', title: `Synthetic image ${position}`, originalUrl: null,
      acquisitionStatus: 'captured',
      blob: { sha256: createHash('sha256').update(`synthetic-image-${position}`).digest('hex'), contentType: 'image/png', byteLength: 17 },
    }));
    payload.attachments = [{ position: 0, kind: 'file', title: 'Synthetic schedule', originalUrl: null, acquisitionStatus: 'captured', blob: { ...pdfBlob } }];
    const input = envelope(payload);
    input.decision.method = 'item-review';
    const parsed = socialAcquisitionEnvelopeSchema.parse(input);
    expect(parsed.payload.content.text).toBe('');
    expect(parsed.payload.media.map((asset) => asset.title)).toEqual(['Synthetic image 0', 'Synthetic image 1']);
    expect(parsed.decision.binding.mediaSha256s).toEqual([...payload.media.map((asset) => asset.blob!.sha256), pdfBlob.sha256]);
  });

  it('keeps item identity and payload approval stable across provider replacement', () => {
    const first = envelope();
    const replacement = structuredClone(first);
    replacement.provenance.provider = { name: 'replacement-provider', version: '9.2' };
    replacement.provenance.exporter.version = '2.0';
    replacement.provenance.acquiredAt = '2026-09-30T01:00:00Z';
    replacement.provenance.runId = 'replacement-run';
    const parsed = socialAcquisitionEnvelopeSchema.parse(replacement);
    expect(parsed.payload.item.sourceItemId).toBe(first.payload.item.sourceItemId);
    expect(parsed.decision.binding).toEqual(first.decision.binding);
  });

  it('distinguishes WeChat multi-article positions, publications, and publishers', () => {
    const id = socialSourceItemId(identity);
    expect(socialSourceItemId({ ...identity, item: { ...identity.item, idx: 2 } })).not.toBe(id);
    expect(socialSourceItemId({ ...identity, item: { ...identity.item, mid: '1002' } })).not.toBe(id);
    expect(socialSourceItemId({ ...identity, publisher: { ...identity.publisher, value: Buffer.from('other-synthetic-publisher').toString('base64') } })).not.toBe(id);
  });

  it.each(['', ' padded-id '])('rejects malformed native identities %j through safeParse', (value) => {
    const publisher = structuredClone(officialPayload);
    publisher.source.publisherIdentity = { ...identity.publisher, value };
    expect(socialEnvelopePayloadSchema.safeParse(publisher).success).toBe(false);
    const item = structuredClone(officialPayload);
    item.item.nativeIdentity = { ...identity.item, mid: value };
    expect(socialEnvelopePayloadSchema.safeParse(item).success).toBe(false);
    expect(() => socialSourceItemId({ ...identity, item: { ...identity.item, mid: value } })).toThrow();
  });

  it('ignores input object key order when binding a publication decision', () => {
    const payload = Object.fromEntries(Object.entries(officialPayload).reverse()) as SocialEnvelopePayload;
    expect(socialPublicationBinding(payload)).toEqual(socialPublicationBinding(officialPayload));
  });

  it.each(['cookies', 'session', 'viewer', 'friendContext', 'comments', 'collectorAccountId'])('rejects unexpected %s metadata at every object tier', (key) => {
    const payload = structuredClone(officialPayload);
    payload.media = [{ position: 0, kind: 'image', title: 'Synthetic image', originalUrl: null, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
    payload.attachments = [{ ...payload.media[0]!, kind: 'file', blob: { ...pdfBlob } }];
    payload.attribution.origin = { publisherName: 'Synthetic origin', publisherId: null, nativeItemId: null, url: null };
    payload.attribution.evidence = [{ kind: 'operator-review', description: 'Synthetic review', url: null, blobSha256: rawBlob.sha256 }];
    const input = envelope(payload);
    expect(socialAcquisitionEnvelopeSchema.parse(input).decision.status).toBe('approved');
    const targets = [input, input.payload, input.payload.source, input.payload.source.publisherIdentity,
      input.payload.item, input.payload.item.nativeIdentity, input.payload.publicationTime,
      input.payload.publicationTime.original!, input.payload.content, input.payload.attribution,
      input.payload.attribution.origin!, input.payload.attribution.evidence[0]!, input.payload.media[0]!,
      input.payload.media[0]!.blob!, input.payload.attachments[0]!, input.payload.attachments[0]!.blob!,
      input.payload.rawBlobs[0]!, input.payload.rawBlobs[0]!.blob, input.provenance,
      input.provenance.provider, input.provenance.exporter, input.decision, input.decision.binding];
    for (const target of targets) {
      Object.assign(target, { [key]: 'synthetic-forbidden-metadata' });
      expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
      delete (target as unknown as Record<string, unknown>)[key];
    }
    expect(socialAcquisitionBundleSchema.safeParse({ schemaVersion: 1, bundleId: 'example', envelopes: [input], [key]: 'synthetic-forbidden-metadata' }).success).toBe(false);
  });

  it.each(['not-a-url', 'http://public.example/post', 'javascript:alert(1)', 'https://user:example@public.example/post',
    'https://public.example/post?token=synthetic', 'https://public.example/post?session=synthetic',
    'https://public.example/post?toString=synthetic', 'https://public.example/post#synthetic'])('rejects unsafe URL %s without throwing outside Zod', (url) => {
    const payload = structuredClone(officialPayload);
    payload.item.canonicalUrl = url;
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it.each(['a'.repeat(63), 'G'.repeat(64), 'A'.repeat(64)])('rejects invalid raw and approval hashes %s', (hash) => {
    const input = envelope();
    input.payload.rawBlobs[0]!.blob.sha256 = hash;
    input.decision.binding.payloadSha256 = hash;
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['role', 'administrator'], ['access', 'personal-login'], ['redistributionMode', 'public'],
    ['platform', 'qq-chat'], ['audience', 'friends'],
  ])('rejects invalid policy %s=%s', (key, value) => {
    const input = envelope();
    Object.assign(input.payload.source, { [key]: value });
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it('rejects stale decisions after content or media changes and identity mismatches', () => {
    const input = envelope();
    input.payload.content.text = 'Changed service time';
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
    const assetChange = envelope();
    assetChange.payload.media = [{ position: 0, kind: 'image', title: 'New image', originalUrl: null, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
    expect(socialAcquisitionEnvelopeSchema.safeParse(assetChange).success).toBe(false);
    const wrongIdentity = envelope();
    wrongIdentity.payload.item.nativeIdentity = { ...identity.item, mid: '1002' };
    expect(socialAcquisitionEnvelopeSchema.safeParse(wrongIdentity).success).toBe(false);
  });

  it('rejects wider redistribution, unreviewed review-only approval, and mismatched policy versions', () => {
    const payload = structuredClone(officialPayload);
    payload.source.redistributionMode = 'summary';
    expect(socialAcquisitionEnvelopeSchema.safeParse(envelope(payload)).success).toBe(false);
    payload.source.redistributionMode = 'denied';
    expect(socialAcquisitionEnvelopeSchema.safeParse(envelope(payload)).success).toBe(false);
    payload.source.redistributionMode = 'review-only';
    expect(socialAcquisitionEnvelopeSchema.safeParse(envelope(payload)).success).toBe(false);
    const input = envelope();
    input.decision.policyVersion = 'different-policy';
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it('accepts honest missing-time and unavailable-media declarations but rejects invented precision', () => {
    const payload = structuredClone(officialPayload);
    payload.publicationTime = { original: null, precision: 'unknown', timezone: null, normalizedAt: null, publishedOn: null };
    payload.content.completeness = 'partial';
    payload.media = [{ position: 0, kind: 'image', title: 'Unavailable image', originalUrl: null, acquisitionStatus: 'unavailable', blob: null }];
    expect(socialAcquisitionEnvelopeSchema.parse(envelope(payload)).payload.media[0]?.acquisitionStatus).toBe('unavailable');
    payload.publicationTime.normalizedAt = '2026-09-29T00:00:00Z';
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects malformed dates, unavailable assets with blobs, and noncontiguous positions', () => {
    const payload = structuredClone(officialPayload);
    payload.publicationTime.publishedOn = '2026-02-30';
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
    payload.publicationTime.publishedOn = null;
    payload.media = [{ position: 1, kind: 'image', title: 'Bad image', originalUrl: null, acquisitionStatus: 'unavailable', blob: rawBlob }];
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('accepts metadata-only publication without fabricating article content', () => {
    const payload = structuredClone(officialPayload);
    payload.source.redistributionMode = 'link-only';
    payload.content = { title: '示例原文链接', text: '', html: '', completeness: 'link-only' };
    const input = envelope(payload);
    input.decision.mode = 'link-only';
    expect(socialAcquisitionEnvelopeSchema.parse(input).payload.content).toEqual(payload.content);
    input.payload.content.text = 'Unexpected body';
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unsupported contract and identity versions', () => {
    const input = envelope();
    expect(socialAcquisitionEnvelopeSchema.safeParse({ ...input, schemaVersion: 2 }).success).toBe(false);
    expect(socialAcquisitionBundleSchema.safeParse({ schemaVersion: 2, bundleId: 'example', envelopes: [input] }).success).toBe(false);
    expect(socialEnvelopePayloadSchema.safeParse({ ...input.payload, item: { ...input.payload.item, nativeIdentity: { ...identity.item, version: 2 } } }).success).toBe(false);
  });

  it.each(['full', 'summary', 'link-only'] as const)('forbids whole-stream %s sentinel source policies', (redistributionMode) => {
    const payload = structuredClone(officialPayload);
    payload.source.role = 'sentinel';
    payload.source.redistributionMode = redistributionMode;
    const result = socialEnvelopePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === 'source.redistributionMode')).toBe(true);
  });

  it('requires item review for every approved sentinel item and permits denied source retention', () => {
    const payload = structuredClone(officialPayload);
    payload.source.role = 'sentinel';
    payload.source.redistributionMode = 'review-only';
    const input = envelope(payload);
    expect(socialAcquisitionEnvelopeSchema.safeParse(input).success).toBe(false);
    input.decision.method = 'item-review';
    expect(socialAcquisitionEnvelopeSchema.parse(input).decision.method).toBe('item-review');
    payload.source.redistributionMode = 'denied';
    const denied = envelope(payload);
    expect(socialAcquisitionEnvelopeSchema.safeParse(denied).success).toBe(false);
    denied.decision.status = 'rejected';
    denied.decision.mode = 'none';
    expect(socialAcquisitionEnvelopeSchema.parse(denied).decision.status).toBe('rejected');
  });

  it('canonicalizes verified mid/appmsgid aliases without merging multi-article positions', () => {
    const mid = wechatArticleIdentity({ mid: '1001', appmsgid: null, idx: 1 });
    const fallback = wechatArticleIdentity({ mid: null, appmsgid: '1001', idx: 1 });
    expect(socialSourceItemId({ ...identity, item: mid })).toBe(socialSourceItemId({ ...identity, item: fallback }));
    expect(wechatArticleIdentity({ mid: '1001', appmsgid: '1001', idx: 1 })).toEqual(mid);
    expect(socialSourceItemId({ ...identity, item: wechatArticleIdentity({ mid: '1001', appmsgid: null, idx: 2 }) }))
      .not.toBe(socialSourceItemId({ ...identity, item: mid }));
  });

  it('makes missing, conflicting, and noncanonical native WeChat fields not importable', () => {
    expect(() => wechatArticleIdentity({ mid: null, appmsgid: null, idx: 1 })).toThrow();
    expect(() => wechatArticleIdentity({ mid: '1001', appmsgid: '1002', idx: 1 })).toThrow();
    expect(() => wechatArticleIdentity({ mid: '01001', appmsgid: null, idx: 1 })).toThrow();
    expect(() => wechatArticleIdentity({ mid: '1001', appmsgid: null, idx: 0 })).toThrow();
    expect(socialNativeIdentitySchema.safeParse({ ...identity, item: { scheme: 'wechat-mid-idx', version: 1, mid: '1001' } }).success).toBe(false);
    expect(socialNativeIdentitySchema.safeParse({ ...identity, publisher: { ...identity.publisher, value: identity.publisher.value.replace(/=+$/, '') } }).success).toBe(false);
  });

  it('uses QZone publisher UIN and case-sensitive tid, never provider IDs or URLs', () => {
    const qzone = { platform: 'qzone', publisher: { scheme: 'qzone-uin', version: 1, value: '123456789' }, item: { scheme: 'qzone-tid', version: 1, tid: 'synthetic-tid' } } as const;
    const id = socialSourceItemId(qzone);
    expect(socialSourceItemId({ ...qzone, publisher: { ...qzone.publisher, value: '123456790' } })).not.toBe(id);
    expect(socialSourceItemId({ ...qzone, item: { ...qzone.item, tid: 'SYNTHETIC-TID' } })).not.toBe(id);
    expect(socialNativeIdentitySchema.safeParse({ ...qzone, item: { scheme: 'qzone-tid', version: 1, providerId: 'synthetic-database-id' } }).success).toBe(false);
    expect(socialNativeIdentitySchema.safeParse({ ...qzone, item: { ...qzone.item, url: 'https://public.example/posts/1' } }).success).toBe(false);
    expect(socialNativeIdentitySchema.safeParse({ ...qzone, publisher: identity.publisher }).success).toBe(false);
  });

  it('permits public routing and media formatting only for the appropriate URL purposes', () => {
    const payload = structuredClone(officialPayload);
    const routing = 'https://job.nju.edu.cn/career/info/123?type=NEWS';
    const image = 'https://mmbiz.qpic.cn/mmbiz_png/synthetic/0?wx_fmt=png&width=640';
    payload.item.originalUrl = routing;
    payload.item.canonicalUrl = routing;
    payload.attribution.origin = { publisherName: 'Synthetic public origin', publisherId: null, nativeItemId: null, url: routing };
    payload.media = [{ position: 0, kind: 'image', title: 'Synthetic image', originalUrl: image, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
    const parsed = socialEnvelopePayloadSchema.parse(payload);
    expect(parsed.item.canonicalUrl).toBe(routing);
    expect(parsed.media[0]?.originalUrl).toBe(image);
    payload.item.canonicalUrl = image;
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
    payload.item.canonicalUrl = routing;
    payload.media[0]!.originalUrl = 'https://public.example/image?post=1';
    expect(socialEnvelopePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it.each(['session_id', 'access_token', 'AUTHORIZATION', 'p_skey', 'qzonetoken', 'api-key', 'utm_source', 'wxfrom'])('rejects %s query material at all URL boundaries', (key) => {
    const url = `https://public.example/content?${key}=synthetic-forbidden-material`;
    const publication = structuredClone(officialPayload);
    publication.item.originalUrl = url;
    expect(socialEnvelopePayloadSchema.safeParse(publication).success).toBe(false);
    const asset = structuredClone(officialPayload);
    asset.media = [{ position: 0, kind: 'image', title: 'Synthetic image', originalUrl: url, acquisitionStatus: 'captured', blob: { ...imageBlob } }];
    expect(socialEnvelopePayloadSchema.safeParse(asset).success).toBe(false);
    const attribution = structuredClone(officialPayload);
    attribution.attribution.origin = { publisherName: 'Synthetic origin', publisherId: null, nativeItemId: null, url };
    expect(socialEnvelopePayloadSchema.safeParse(attribution).success).toBe(false);
  });

  it('resolves declared screenshot evidence from raw, media, and attachment manifests', () => {
    const payload = structuredClone(officialPayload);
    const screenshot = { ...imageBlob };
    payload.rawBlobs[0]!.blob = screenshot;
    payload.rawBlobs[0]!.evidenceKind = 'screenshot';
    payload.attribution.evidence = [{ kind: 'screenshot', description: 'Synthetic public screenshot', url: null, blobSha256: screenshot.sha256 }];
    expect(socialEnvelopePayloadSchema.parse(payload).attribution.evidence[0]?.blobSha256).toBe(screenshot.sha256);
    const captured = fixtureBlob('different synthetic screenshot', 'image/png');
    payload.media = [{ position: 0, kind: 'image', title: 'Screenshot', originalUrl: null, acquisitionStatus: 'captured', blob: captured }];
    payload.attribution.evidence[0]!.blobSha256 = captured.sha256;
    expect(socialEnvelopePayloadSchema.parse(payload).attribution.evidence[0]?.blobSha256).toBe(captured.sha256);
    payload.attachments = [{ ...payload.media[0]!, kind: 'file' }];
    payload.media = [];
    expect(socialEnvelopePayloadSchema.parse(payload).attribution.evidence[0]?.blobSha256).toBe(captured.sha256);
  });

  it('rejects a dangling attribution hash even when it is a valid SHA-256', () => {
    const payload = structuredClone(officialPayload);
    payload.attribution.evidence = [{ kind: 'screenshot', description: 'Undeclared synthetic screenshot', url: null, blobSha256: 'f'.repeat(64) }];
    const result = socialEnvelopePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === 'attribution.evidence.0.blobSha256')).toBe(true);
  });

  it.each([
    { original: { value: '1970-01-01', representation: 'iso8601' }, precision: 'day', timezone: null, normalizedAt: null, publishedOn: '1970-01-01' },
    { original: { value: '2026-09-29T08:30+08:00', representation: 'iso8601' }, precision: 'minute', timezone: '+08:00', normalizedAt: '2026-09-29T00:30:00Z', publishedOn: '2026-09-29' },
    { original: { value: '2026-09-29T23:30:00Z', representation: 'iso8601' }, precision: 'second', timezone: 'Asia/Shanghai', normalizedAt: '2026-09-30T07:30:00+08:00', publishedOn: '2026-09-30' },
    { original: { value: '0', representation: 'unix-seconds' }, precision: 'second', timezone: 'UTC', normalizedAt: '1970-01-01T00:00:00Z', publishedOn: '1970-01-01' },
    { original: { value: '1', representation: 'unix-milliseconds' }, precision: 'millisecond', timezone: 'Z', normalizedAt: '1970-01-01T00:00:00.001Z', publishedOn: '1970-01-01' },
    { original: { value: '2026年9月29日', representation: 'text' }, precision: 'day', timezone: null, normalizedAt: null, publishedOn: '2026-09-29' },
    { original: { value: '昨晚', representation: 'text' }, precision: 'unknown', timezone: null, normalizedAt: null, publishedOn: null },
  ] satisfies Array<SocialEnvelopePayload['publicationTime']>)('preserves consistent publication time $original.value', (publicationTime) => {
    const parsed = socialEnvelopePayloadSchema.parse({ ...officialPayload, publicationTime });
    expect(parsed.publicationTime).toEqual(publicationTime);
  });

  it.each(['NaN', 'Infinity', '-1', '1.5', '1e3', '001', '9007199254740993', '253402300800000000'])('rejects invalid Unix numeric original %s in both units', (value) => {
    for (const representation of ['unix-seconds', 'unix-milliseconds'] as const) {
      const publicationTime = { original: { value, representation }, precision: representation === 'unix-seconds' ? 'second' : 'millisecond', timezone: null, normalizedAt: null, publishedOn: null };
      expect(socialEnvelopePayloadSchema.safeParse({ ...officialPayload, publicationTime }).success).toBe(false);
    }
  });

  it.each([
    { original: { value: 'not-a-date', representation: 'iso8601' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-02-30T00:00:00Z', representation: 'iso8601' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-09-29', representation: 'iso8601' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-09-29T08:30:00Z', representation: 'iso8601' }, precision: 'millisecond', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-09-29T08:30:00.001Z', representation: 'iso8601' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-09-29T08:30:00.123456Z', representation: 'iso8601' }, precision: 'millisecond', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '2026-09-29T08:30:00', representation: 'iso8601' }, precision: 'second', timezone: 'Asia/Shanghai', normalizedAt: null, publishedOn: null },
    { original: { value: '0', representation: 'unix-seconds' }, precision: 'millisecond', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '0', representation: 'unix-milliseconds' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: null },
    { original: { value: '0', representation: 'unix-seconds' }, precision: 'second', timezone: null, normalizedAt: null, publishedOn: '1970-01-01' },
    { original: { value: '2026-09-29 08:30:00', representation: 'text' }, precision: 'second', timezone: 'Asia/Shanghai', normalizedAt: '2026-09-29T00:30:00Z', publishedOn: '2026-09-29' },
    { original: { value: '昨晚', representation: 'text' }, precision: 'day', timezone: null, normalizedAt: null, publishedOn: '2026-09-29' },
  ] satisfies Array<SocialEnvelopePayload['publicationTime']>)('rejects invalid original/precision declaration $original.value/$precision', (publicationTime) => {
    expect(socialEnvelopePayloadSchema.safeParse({ ...officialPayload, publicationTime }).success).toBe(false);
  });

  it('rejects normalized instants, source calendar days, and timezone declarations that disagree', () => {
    const publicationTime: SocialEnvelopePayload['publicationTime'] = {
      original: { value: '2026-09-29T23:30:00Z', representation: 'iso8601' }, precision: 'second',
      timezone: 'Asia/Shanghai', normalizedAt: '2026-09-29T23:30:00Z', publishedOn: '2026-09-29',
    };
    expect(socialEnvelopePayloadSchema.safeParse({ ...officialPayload, publicationTime }).success).toBe(false);
    publicationTime.publishedOn = '2026-09-30';
    publicationTime.normalizedAt = '2026-09-30T23:30:00Z';
    expect(socialEnvelopePayloadSchema.safeParse({ ...officialPayload, publicationTime }).success).toBe(false);
    publicationTime.normalizedAt = '2026-09-29T23:30:00Z';
    publicationTime.timezone = 'not-a-timezone';
    expect(socialEnvelopePayloadSchema.safeParse({ ...officialPayload, publicationTime }).success).toBe(false);
  });

  it.each(['0000', '0001'])('retains ISO calendar year %s through IANA formatting', (year) => {
    const publishedOn = `${year}-01-01`;
    const normalizedAt = `${publishedOn}T00:00:00Z`;
    const publicationTime: SocialEnvelopePayload['publicationTime'] = {
      original: { value: normalizedAt, representation: 'iso8601' }, precision: 'second',
      timezone: 'Etc/UTC', normalizedAt, publishedOn,
    };
    expect(socialEnvelopePayloadSchema.parse({ ...officialPayload, publicationTime }).publicationTime.publishedOn).toBe(publishedOn);
  });

  it('accepts one consistent blob reused across raw, media, and attachment references', () => {
    const parsed = socialEnvelopePayloadSchema.parse(sharedBlobPayload());
    expect(parsed.rawBlobs[0]!.blob).toEqual(imageBlob);
    expect(parsed.media[0]!.blob).toEqual(imageBlob);
    expect(parsed.attachments[0]!.blob).toEqual(imageBlob);
  });

  it.each(['rawBlobs', 'media', 'attachments'] as const)('rejects conflicting length or MIME declarations on %s', (surface) => {
    for (const field of ['byteLength', 'contentType'] as const) {
      const payload = sharedBlobPayload();
      const blob = payload[surface][0]!.blob!;
      if (field === 'byteLength') blob.byteLength += 1;
      else blob.contentType = 'application/octet-stream';
      const result = socialEnvelopePayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some((issue) => issue.path.at(-1) === field)).toBe(true);
    }
  });

  it('rejects contradictory lengths within raw-only repeated references', () => {
    const payload = structuredClone(officialPayload);
    payload.rawBlobs.push({ ...payload.rawBlobs[0]!, blob: { ...rawBlob, byteLength: rawBlob.byteLength + 1 } });
    const result = socialEnvelopePayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === 'rawBlobs.1.blob.byteLength')).toBe(true);
  });

  it('accepts consistent shared blob declarations across independent envelopes', () => {
    const parsed = parseSocialAcquisitionBundle(sharedBlobBundle());
    expect(parsed.envelopes[0]!.payload.rawBlobs[0]!.blob).toEqual(parsed.envelopes[1]!.payload.media[0]!.blob);
    expect(parsed.envelopes[0]!.payload.item.sourceItemId).not.toBe(parsed.envelopes[1]!.payload.item.sourceItemId);
  });

  it.each(['byteLength', 'contentType'] as const)('rejects cross-envelope shared blob conflicts on %s', (field) => {
    const bundle = sharedBlobBundle();
    const second = bundle.envelopes[1]!;
    const blob = second.payload.media[0]!.blob!;
    if (field === 'byteLength') blob.byteLength += 1;
    else blob.contentType = 'application/octet-stream';
    second.decision.binding = socialPublicationBinding(second.payload);
    expect(socialAcquisitionEnvelopeSchema.parse(second).decision.status).toBe('approved');
    const result = socialAcquisitionBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.join('.') === `envelopes.1.payload.media.0.blob.${field}`)).toBe(true);
  });
});
