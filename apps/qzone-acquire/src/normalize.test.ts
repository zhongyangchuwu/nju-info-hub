import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { socialSourceItemId } from '@nju-info/core';
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
