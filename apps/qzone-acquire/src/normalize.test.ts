import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { socialEnvelopePayloadSchema, socialSourceItemId } from '@nju-info/core';
import { normalizeQzonePost, projectQzonePost, type QzonePost } from './normalize.js';

const feedResponse = JSON.parse(readFileSync(new URL('./fixtures/feed-response.json', import.meta.url), 'utf8')) as {
  data: { items: unknown[] };
};
const detailResponse = JSON.parse(readFileSync(new URL('./fixtures/detail-response.json', import.meta.url), 'utf8')) as {
  data: { post: unknown };
};
const feedPost = feedResponse.data.items[0];
const detailPost = detailResponse.data.post;
const expectedUin = '123456789';
const expectedId = '123456789:synthetic-Tid_01';
const photoStorePost = JSON.parse(readFileSync(new URL('./fixtures/photo-store-post.json', import.meta.url), 'utf8')) as {
  id: string; author: { uin: number }; created_at: number; content: string; images: string[];
};

describe('QZone post projection', () => {
  it('positively projects feed and detail posts without unused provider fields', () => {
    const projectedFeed = projectQzonePost(feedPost, expectedUin);
    const projectedDetail = projectQzonePost(detailPost, expectedUin, expectedId);
    const expected: QzonePost = {
      uin: expectedUin,
      tid: 'synthetic-Tid_01',
      created_at: 1790724600,
      content: 'Synthetic restricted acquisition text',
      mediaUrls: [
        'https://images.example.invalid/first.png',
        'https://images.example.invalid/second.png?width=640',
      ],
    };
    expect(projectedFeed).toEqual(expected);
    expect(projectedDetail).toEqual(expected);
    expect(JSON.stringify(projectedFeed)).not.toMatch(/comments|viewer|stats|avatar|nickname|session|token/i);
  });

  it.each([
    ['missing native ID', (post: Record<string, unknown>) => {
      delete post.id;
    }],
    ['missing author', (post: Record<string, unknown>) => {
      delete post.author;
    }],
    ['invalid author UIN', (post: Record<string, unknown>) => {
      (post.author as Record<string, unknown>).uin = '123456789';
    }],
    ['foreign publisher UIN', (post: Record<string, unknown>) => {
      (post.author as Record<string, unknown>).uin = 123456788;
    }],
    ['foreign ID publisher', (post: Record<string, unknown>) => {
      post.id = '123456788:synthetic-Tid_01';
    }],
    ['detail ID mismatch', (post: Record<string, unknown>) => {
      post.id = '123456789:another-tid';
    }],
    ['whitespace in native ID', (post: Record<string, unknown>) => {
      post.id = '123456789:unstable tid';
    }],
    ['control character in native ID', (post: Record<string, unknown>) => {
      post.id = '123456789:unstable\u0001tid';
    }],
    ['unsafe numeric UIN', (post: Record<string, unknown>) => {
      (post.author as Record<string, unknown>).uin = 9007199254740992;
      post.id = '9007199254740992:synthetic-Tid_01';
    }],
    ['missing timestamp', (post: Record<string, unknown>) => {
      delete post.created_at;
    }],
    ['zero timestamp sentinel', (post: Record<string, unknown>) => {
      post.created_at = 0;
    }],
    ['fractional timestamp', (post: Record<string, unknown>) => {
      post.created_at = 1790724600.5;
    }],
    ['timestamp after year 9999', (post: Record<string, unknown>) => {
      post.created_at = 253402300800;
    }],
    ['missing text', (post: Record<string, unknown>) => {
      delete post.content;
    }],
    ['missing images', (post: Record<string, unknown>) => {
      delete post.images;
    }],
    ['credential-bearing image URL', (post: Record<string, unknown>) => {
      post.images = ['https://images.example.invalid/photo.png?session_id=synthetic-private-value'];
    }],
    ['unsupported image query parameter', (post: Record<string, unknown>) => {
      post.images = ['https://images.example.invalid/photo.png?post=synthetic-private-value'];
    }],
  ])('rejects %s with a fixed message', (_case, mutate) => {
    const input = structuredClone(feedPost) as Record<string, unknown>;
    mutate(input);
    expect(() => projectQzonePost(input, expectedUin, expectedId)).toThrowError('Invalid QZone post.');
  });
});

describe('QZone candidate normalization', () => {
  const projected = projectQzonePost(feedPost, expectedUin);

  it('uses stable QZone identity and a restricted, honest partial candidate', () => {
    const candidate = normalizeQzonePost(projected);
    expect(candidate).toEqual({
      sourceItemId: socialSourceItemId({
        platform: 'qzone',
        publisher: { scheme: 'qzone-uin', version: 1, value: expectedUin },
        item: { scheme: 'qzone-tid', version: 1, tid: 'synthetic-Tid_01' },
      }),
      publisherIdentity: { scheme: 'qzone-uin', version: 1, value: expectedUin },
      nativeIdentity: { scheme: 'qzone-tid', version: 1, tid: 'synthetic-Tid_01' },
      originalUrl: 'https://user.qzone.qq.com/123456789/mood/synthetic-Tid_01',
      publicationTime: {
        original: { value: '1790724600', representation: 'unix-seconds' },
        precision: 'second',
        timezone: 'Asia/Shanghai',
        normalizedAt: '2026-09-29T23:30:00.000Z',
        publishedOn: '2026-09-30',
      },
      content: { text: 'Synthetic restricted acquisition text', html: '', completeness: 'partial' },
      media: [
        { position: 0, originalUrl: 'https://images.example.invalid/first.png', acquisitionStatus: 'not-requested' },
        { position: 1, originalUrl: 'https://images.example.invalid/second.png?width=640', acquisitionStatus: 'not-requested' },
      ],
      attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
    });
    expect(candidate.content.completeness).toBe('partial');
    expect(candidate.attribution).toEqual({ relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] });
    expect(Object.keys(candidate)).not.toContain('publicSafe');
  });

  it('percent-encodes native IDs in the restricted publication URL', () => {
    const candidate = normalizeQzonePost({ ...projected, tid: 'synthetic:child' });
    expect(candidate.nativeIdentity).toEqual({ scheme: 'qzone-tid', version: 1, tid: 'synthetic:child' });
    expect(candidate.originalUrl).toBe('https://user.qzone.qq.com/123456789/mood/synthetic%3Achild');
  });

  it('normalizes exact UTC seconds and uses the Shanghai calendar day across UTC midnight', () => {
    const timestamp = Date.parse('2026-09-29T23:30:00Z') / 1000;
    const candidate = normalizeQzonePost({ ...projected, created_at: timestamp });
    expect(candidate.publicationTime).toEqual({
      original: { value: String(timestamp), representation: 'unix-seconds' },
      precision: 'second',
      timezone: 'Asia/Shanghai',
      normalizedAt: '2026-09-29T23:30:00.000Z',
      publishedOn: '2026-09-30',
    });
  });

  it.each([
    ['zero sentinel', 0],
    ['negative timestamp', -1],
    ['fractional timestamp', 1790724600.1],
    ['unsafe timestamp', Number.MAX_SAFE_INTEGER + 1],
    ['beyond year 9999', 253402300800],
  ])('rejects %s with a fixed message', (_case, created_at) => {
    expect(() => normalizeQzonePost({ ...projected, created_at })).toThrowError('Invalid QZone candidate.');
  });

  it('rejects media URLs that violate the core asset policy', () => {
    expect(() => normalizeQzonePost({
      ...projected,
      mediaUrls: ['https://images.example.invalid/photo.png?access_token=synthetic-secret'],
    })).toThrowError('Invalid QZone candidate.');
  });
});

describe('qualified QQ photo-store media canonicalization', () => {
  it('preserves provider evidence and image order while producing HTTPS locators with stable identity', () => {
    const projected = projectQzonePost(photoStorePost, '10001', photoStorePost.id);
    const candidate = normalizeQzonePost(projected);
    expect(projected.mediaUrls).toEqual(photoStorePost.images);
    expect(candidate.media).toEqual([
      { position: 0, originalUrl: 'https://photonjmaz.photo.store.qq.com/psc/synthetic-first/0', acquisitionStatus: 'not-requested' },
      { position: 1, originalUrl: 'https://photonjmaz.photo.store.qq.com/psc/synthetic-second%2Fvariant/0?width=640&height=480', acquisitionStatus: 'not-requested' },
      { position: 2, originalUrl: 'https://photonjmaz.photo.store.qq.com/psc/synthetic-third/0?format=png&size=large', acquisitionStatus: 'not-requested' },
    ]);
    expect(candidate.content.completeness).toBe('partial');
    const publicAssetSchema = socialEnvelopePayloadSchema.shape.media.element.shape.originalUrl;
    for (const providerUrl of projected.mediaUrls) expect(publicAssetSchema.safeParse(providerUrl).success).toBe(false);
    for (const media of candidate.media) expect(publicAssetSchema.parse(media.originalUrl)).toBe(media.originalUrl);
    const httpsReplay = normalizeQzonePost({ ...projected, mediaUrls: candidate.media.map((media) => media.originalUrl) });
    expect(httpsReplay.sourceItemId).toBe(candidate.sourceItemId);
    expect(httpsReplay.media).toEqual(candidate.media);
  });

  it.each([
    ['http://photo.store.qq.com/image', 'https://photo.store.qq.com/image'],
    ['http://cdn.photo.store.qq.com/image?q=90', 'https://cdn.photo.store.qq.com/image?q=90'],
    ['HTTP://PHOTONJMAZ.PHOTO.STORE.QQ.COM/image?width=640', 'https://PHOTONJMAZ.PHOTO.STORE.QQ.COM/image?width=640'],
    ['https://images.example.invalid/unchanged.png?format=png', 'https://images.example.invalid/unchanged.png?format=png'],
  ])('changes only the qualified scheme of %s', (providerUrl, canonicalUrl) => {
    const projected = projectQzonePost({ ...photoStorePost, images: [providerUrl] }, '10001');
    expect(normalizeQzonePost(projected).media[0]?.originalUrl).toBe(canonicalUrl);
    expect(projected.mediaUrls).toEqual([providerUrl]);
  });

  it.each([
    'http://images.example.invalid/image',
    'http://photonjmaz.photo.store.qq.com.evil.example/image',
    'http://evilphoto.store.qq.com/image',
    'http://photonjmaz.photo.store.qq.com:80/image',
    'http://photonjmaz.photo.store.qq.com:8443/image',
    'http://user:password@photonjmaz.photo.store.qq.com/image',
    'http://@photonjmaz.photo.store.qq.com/image',
    'https://user:password@photonjmaz.photo.store.qq.com/image',
    'http://photonjmaz.photo.store.qq.com/image#fragment',
    'http://photonjmaz.photo.store.qq.com/image#',
    'https://photonjmaz.photo.store.qq.com/image#fragment',
    'http://photonjmaz.photo.store.qq.com/image?access_token=synthetic-secret',
    'http://photonjmaz.photo.store.qq.com/image?%70_skey=synthetic-secret',
    'http://photonjmaz.photo.store.qq.com/image?SESSION_ID=synthetic-secret',
    'http://photonjmaz.photo.store.qq.com/image?unapproved=value',
    'https://photonjmaz.photo.store.qq.com/image?access_token=synthetic-secret',
    'http://photonjmaz.photo.store.qq.com/image?redirect=https%3A%2F%2Fevil.example',
    'http:/photonjmaz.photo.store.qq.com/image',
    'http:///photonjmaz.photo.store.qq.com/image',
    'https:/photonjmaz.photo.store.qq.com/image',
    '//photonjmaz.photo.store.qq.com/image',
    'http://photonjmaz.photo.store.qq.com/image%GG',
    'https://photonjmaz.photo.store.qq.com/image%',
    'http://photonjmaz.photo.store.qq.com/\\image',
    'https://photonjmaz.photo.store.qq.com/\\image',
    'http://photonjmaz.photo.store.qq.com/image\n',
    'http://photonjmaz.photo.store.qq.com./image',
    'http://photonjmaz%2Ephoto.store.qq.com/image',
    'http://-cdn.photo.store.qq.com/image',
    'http://cdn_.photo.store.qq.com/image',
    `http://${'a'.repeat(64)}.photo.store.qq.com/image`,
    `http://${Array(4).fill('a'.repeat(63)).join('.')}.photo.store.qq.com/image`,
    'not-a-url',
  ])('rejects unsafe media at extraction and normalization: %s', (providerUrl) => {
    expect(() => projectQzonePost({ ...photoStorePost, images: [providerUrl] }, '10001')).toThrow('Invalid QZone post.');
    expect(() => normalizeQzonePost({
      uin: '10001', tid: 'PhotoStore-Tid_01', created_at: photoStorePost.created_at,
      content: photoStorePost.content, mediaUrls: [providerUrl],
    })).toThrow('Invalid QZone candidate.');
  });
});
