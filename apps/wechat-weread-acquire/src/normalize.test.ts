import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeWereadLatest, wereadLatestExportSchema } from './normalize.js';

async function fixture() {
  const path = fileURLToPath(new URL('./fixtures/latest-export.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('normalizeWereadLatest', () => {
  it('creates stable canonical WeChat identity while remaining publication-ineligible', async () => {
    const input = await fixture();
    const candidate = normalizeWereadLatest(input);
    expect(candidate.shadowItemId).toMatch(/^wechat-weread-review-v1:[a-f0-9]{64}$/);
    expect(candidate.publicationEligible).toBe(false);
    expect(candidate.bundleIdentityEligible).toBe(true);
    expect(candidate.bundleEligible).toBe(false);
    expect(candidate.source.decodedBookId).toBe('1234567890');
    expect(candidate.source.publisherIdentity).toEqual({
      scheme: 'wechat-biz', version: 1, value: 'MTIzNDU2Nzg5MA==',
    });
    expect(candidate.item.nativeIdentity).toEqual({
      scheme: 'wechat-mid-idx', version: 1, mid: '10001', idx: 1,
    });
    expect(candidate.item.sourceItemId).toMatch(/^social-native-v1:[a-f0-9]{64}$/);
    expect(candidate.item.originalUrl).toBe('https://mp.weixin.qq.com/s/syntheticReviewToken');
    const canonical = new URL(candidate.item.canonicalUrl);
    expect(canonical.searchParams.get('__biz')).toBe('MTIzNDU2Nzg5MA==');
    expect(canonical.searchParams.get('mid')).toBe('10001');
    expect(canonical.searchParams.get('idx')).toBe('1');
    expect(canonical.searchParams.get('sn')).toBe('0123456789abcdef0123456789abcdef');
    expect(candidate.item.publicationTime).toEqual({
      original: { value: '1790812560', representation: 'unix-seconds' },
      precision: 'second',
      timezone: 'Asia/Shanghai',
      normalizedAt: '2026-09-30T23:56:00.000Z',
      publishedOn: '2026-10-01',
    });
    expect(candidate.identityQualification.publisher.status).toBe('verified');
    expect(candidate.identityQualification.item.status).toBe('complete');
    expect(candidate.discovery).toEqual({ complete: false, reason: 'weread-cover-latest-only' });
  });

  it('is stable across repeated normalization', async () => {
    const input = await fixture();
    const one = normalizeWereadLatest(input);
    const two = normalizeWereadLatest(input);
    expect(one.shadowItemId).toBe(two.shadowItemId);
    expect(one.item.sourceItemId).toBe(two.item.sourceItemId);
  });

  it('rejects a fakerId that does not decode to the feed book ID', async () => {
    const input = await fixture();
    (input.feed as Record<string, unknown>).fakerId = 'MzAxMDA3MjIwMw==';
    expect(() => normalizeWereadLatest(input)).toThrow(/publisher identity mismatch/);
  });

  it('rejects content-page __biz that disagrees with provider fakerId', async () => {
    const input = await fixture();
    (input.latest as Record<string, unknown>).canonicalBiz = 'MzAxMDA3MjIwMw==';
    expect(() => normalizeWereadLatest(input)).toThrow(/__biz does not match/);
  });

  it('rejects a reviewId from another feed', async () => {
    const input = await fixture();
    (input.latest as Record<string, unknown>).reviewId = 'MP_WXS_3010072203_VLPjFfxEelP9gPXGSr0JWg';
    expect(() => normalizeWereadLatest(input)).toThrow(/does not belong/);
  });

  it('rejects invalid canonical message identity', async () => {
    const input = await fixture();
    (input.latest as Record<string, unknown>).mid = '00010001';
    expect(() => normalizeWereadLatest(input)).toThrow();
  });

  it('rejects unexpected provider fields such as cookies', async () => {
    const input = await fixture();
    (input.provider as Record<string, unknown>).cookie = 'must-not-cross-boundary';
    expect(() => wereadLatestExportSchema.parse(input)).toThrow();
  });

  it('rejects non-WeChat cover hosts', async () => {
    const input = await fixture();
    (input.latest as Record<string, unknown>).coverUrl = 'https://example.com/cover.jpg';
    expect(() => normalizeWereadLatest(input)).toThrow();
  });
});
