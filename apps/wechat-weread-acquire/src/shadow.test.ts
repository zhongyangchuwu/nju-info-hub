import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  parseSocialAcquisitionBundle,
  socialPublicationBinding,
} from '@nju-info/core';
import { normalizeWereadLatest } from './normalize.js';
import { buildWereadShadowBundle } from './shadow.js';

const now = new Date('2026-10-07T13:00:00.000Z');

async function sourcePolicy() {
  return JSON.parse(await readFile(new URL('./fixtures/source-policy.json', import.meta.url), 'utf8'));
}

async function candidate() {
  return normalizeWereadLatest(JSON.parse(await readFile(new URL('./fixtures/latest-export.json', import.meta.url), 'utf8')));
}

function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]),
    ) as unknown as T;
  }
  return value;
}

describe('buildWereadShadowBundle', () => {
  it('serializes versioned deterministic metadata independently of restricted fields and input key order', async () => {
    const input = await candidate();
    const policy = await sourcePolicy();
    const baseline = buildWereadShadowBundle(input, policy, 'synthetic-run-1', now);
    const reordered = buildWereadShadowBundle(reverseKeys(input), reverseKeys(policy), 'synthetic-run-1', now);
    const restrictedChanges = structuredClone(input);
    restrictedChanges.item.content.sha256 = 'c'.repeat(64);
    restrictedChanges.item.content.byteLength = 9876;
    restrictedChanges.item.providerReviewId = 'restricted-review-canary';
    restrictedChanges.source.providerFeedId = 'restricted-feed-canary';
    restrictedChanges.item.coverUrl = 'https://mmbiz.qpic.cn/synthetic/changed-cover.jpg';
    const changed = buildWereadShadowBundle(restrictedChanges, policy, 'synthetic-run-1', now);
    const expectedMetadata = {
      schemaVersion: 1,
      sanitizationVersion: 'wechat-weread-link-metadata-v1',
      platform: 'wechat',
      publisherIdentity: { scheme: 'wechat-biz', version: 1, value: 'MTIzNDU2Nzg5MA==' },
      item: {
        nativeIdentity: { scheme: 'wechat-mid-idx', version: 1, mid: '10001', idx: 1 },
        sourceItemId: input.item.sourceItemId,
        originalUrl: 'https://mp.weixin.qq.com/s/syntheticReviewToken',
        canonicalUrl: input.item.canonicalUrl,
        aliases: [],
      },
      publicationTime: {
        original: { value: '1790812560', representation: 'unix-seconds' },
        precision: 'second', timezone: 'Asia/Shanghai',
        normalizedAt: '2026-09-30T23:56:00.000Z', publishedOn: '2026-10-01',
      },
      content: { title: 'Synthetic campus service notice', text: '', html: '', completeness: 'link-only' },
    };
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedMetadata)}\n`, 'utf8');
    expect(baseline.metadataBytes).toEqual(expectedBytes);
    expect(reordered.metadataBytes).toEqual(baseline.metadataBytes);
    expect(changed.metadataBytes).toEqual(baseline.metadataBytes);
    const payload = baseline.bundle.envelopes[0]!.payload;
    expect(payload.rawBlobs).toEqual([{
      blob: {
        sha256: createHash('sha256').update(expectedBytes).digest('hex'),
        contentType: 'application/json; charset=utf-8', byteLength: expectedBytes.byteLength,
      },
      sourceUrl: input.item.canonicalUrl, acquiredAt: input.provenance.acquiredAt,
      evidenceTier: 'public-safe', evidenceKind: 'provider-export',
      sanitizationVersion: 'wechat-weread-link-metadata-v1',
    }]);
    expect(payload.item).toEqual(expectedMetadata.item);
    expect(payload.publicationTime).toEqual(expectedMetadata.publicationTime);
    expect(payload.content).toEqual(expectedMetadata.content);
    expect(payload.media).toEqual([]);
    expect(payload.attachments).toEqual([]);
    expect(payload.attribution).toEqual({ relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] });
    for (const text of [JSON.stringify(baseline.bundle), baseline.metadataBytes.toString('utf8')]) {
      for (const restricted of [input.item.content.sha256, input.item.providerReviewId, input.source.providerFeedId, input.item.coverUrl]) {
        expect(text).not.toContain(restricted);
      }
    }
  });

  it('creates a valid bundle with current provenance and an unapproved decision bound to the payload', async () => {
    const input = await candidate();
    const result = buildWereadShadowBundle(input, await sourcePolicy(), 'synthetic-run-1', now);
    const envelope = parseSocialAcquisitionBundle(result.bundle).envelopes[0]!;
    expect(envelope.provenance).toEqual({
      acquiredAt: input.provenance.acquiredAt, method: 'credentialed-public-export',
      provider: { name: input.provenance.provider.name, version: input.provenance.provider.version },
      exporter: input.provenance.exporter, runId: 'synthetic-run-1',
    });
    expect(envelope.decision).toMatchObject({
      status: 'review-required', mode: 'none', method: 'item-review',
      policyVersion: 'synthetic-review-v1', decidedAt: '2026-10-07T13:00:00.000Z',
      binding: socialPublicationBinding(envelope.payload),
    });
    expect(envelope.decision.binding.mediaSha256s).toEqual([]);
  });

  it.each(['relay', 'sentinel'] as const)('keeps %s publishers behind item review', async (role) => {
    const policy = await sourcePolicy();
    policy.source.role = role;
    const { bundle } = buildWereadShadowBundle(await candidate(), policy, 'synthetic-community-run', now);
    const envelope = parseSocialAcquisitionBundle(bundle).envelopes[0]!;
    expect(envelope.decision).toMatchObject({
      status: 'review-required', mode: 'none', method: 'item-review',
    });

    envelope.decision.status = 'approved';
    envelope.decision.mode = 'link-only';
    envelope.decision.method = 'source-policy';
    expect(() => parseSocialAcquisitionBundle({ ...bundle, envelopes: [envelope] })).toThrow();
  });

  it.each(['originalUrl', 'canonicalUrl'] as const)('rejects unsafe %s', async (field) => {
    const input = await candidate();
    const policy = await sourcePolicy();
    input.item[field] = 'https://mp.weixin.qq.com/s?token=must-not-cross';
    expect(() => buildWereadShadowBundle(input, policy, 'synthetic-run-1', now)).toThrow();
  });

  it('rejects a native identity inconsistent with sourceItemId', async () => {
    const input = await candidate();
    input.item.nativeIdentity.mid = '10002';
    const policy = await sourcePolicy();
    expect(() => buildWereadShadowBundle(input, policy, 'synthetic-run-1', now)).toThrow(/native identity mismatch/);
  });

  it('rejects a publisher identity different from the reviewed policy', async () => {
    const input = await candidate();
    const policy = await sourcePolicy();
    policy.source.publisherIdentity.value = 'OTg3NjU0MzIxMA==';
    expect(() => buildWereadShadowBundle(input, policy, 'synthetic-run-1', now)).toThrow(/publisher identity does not match/);
  });

  it('cannot bypass conservative policy validation by calling the builder directly', async () => {
    const input = await candidate();
    const policy = await sourcePolicy();
    policy.source.redistributionMode = 'full';
    expect(() => buildWereadShadowBundle(input, policy, 'synthetic-run-1', now)).toThrow();
  });

  it.each(['full', 'summary', 'link-only'] as const)('cannot authorize %s with an unapproved decision', async (mode) => {
    const input = await candidate();
    const { bundle } = buildWereadShadowBundle(input, await sourcePolicy(), 'synthetic-run-1', now);
    bundle.envelopes[0]!.decision.mode = mode;
    expect(() => parseSocialAcquisitionBundle(bundle)).toThrow(/unapproved decisions cannot authorize publication/);
  });
});
