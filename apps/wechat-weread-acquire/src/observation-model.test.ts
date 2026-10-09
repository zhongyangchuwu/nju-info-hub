import { describe, expect, it } from 'vitest';
import { normalizeWereadLatest } from './normalize.js';
import {
  buildWereadObservationLedger,
  parseWereadObservations,
  type WereadObservationLedger,
  type WereadObservations,
} from './observation-model.js';
import type { WereadObservationSuccess } from './observation-types.js';

const now = new Date('2026-10-08T12:00:00.000Z');
const cutoffAt = '2026-10-08T11:00:00.000Z';
const publisherIdentity = { scheme: 'wechat-biz', version: 1, value: 'MTIzNDU2Nzg5MA==' } as const;
const first = '2026-10-07T01:00:00.000Z';
const second = '2026-10-07T02:00:00.000Z';
const third = '2026-10-07T03:00:00.000Z';
const published = '2026-10-06T12:00:00.000Z';

type SuccessOptions = {
  mid?: string;
  idx?: number;
  publishedAt?: string;
  providerVersion?: string;
  reviewToken?: string;
  contentHtml?: string;
  publisher?: string;
};

interface DeclaredFailure {
  outcome: 'blocked' | 'error' | 'empty';
  observedAt: string;
}

function success(number: number, acquiredAt: string, options: SuccessOptions = {}): WereadObservationSuccess {
  const publisher = options.publisher ?? publisherIdentity.value;
  const bookId = Buffer.from(publisher, 'base64').toString('utf8');
  const candidate = normalizeWereadLatest({
    schemaVersion: 2,
    acquiredAt,
    provider: { name: 'WeRSS', version: options.providerVersion ?? '1.0.0', mode: 'weread_mp' },
    feed: { id: `MP_WXS_${bookId}`, name: 'Synthetic publisher', fakerId: publisher },
    latest: {
      reviewId: `MP_WXS_${bookId}_${options.reviewToken ?? 'syntheticToken01'}`,
      title: 'Restricted synthetic title',
      coverUrl: 'https://mmbiz.qpic.cn/example.jpg',
      contentHtml: options.contentHtml ?? '<p>synthetic body</p>',
      canonicalBiz: publisher,
      mid: options.mid ?? '10001',
      idx: options.idx ?? 1,
      sn: '0123456789abcdef',
      publicationUnixSeconds: String(Date.parse(options.publishedAt ?? published) / 1000),
    },
  });
  const runId = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  return {
    inputDir: `/restricted/runs/${runId}`,
    runId,
    manifestSha256: 'a'.repeat(64),
    publisherIdentity: candidate.source.publisherIdentity,
    startedAt: new Date(Date.parse(acquiredAt) + 1000).toISOString(),
    completedAt: new Date(Date.parse(acquiredAt) + 2000).toISOString(),
    acquiredAt: candidate.provenance.acquiredAt,
    sourceItemId: candidate.item.sourceItemId,
    nativeIdentity: candidate.item.nativeIdentity,
    publicationTime: candidate.item.publicationTime,
    contentSha256: candidate.item.content.sha256,
  };
}

function declaration(
  runs: WereadObservationSuccess[] = [],
  failures: DeclaredFailure[] = [],
): WereadObservations {
  return parseWereadObservations({
    schemaVersion: 1,
    publisherIdentity,
    cutoffAt,
    attempts: [
      ...runs.map((run) => ({ outcome: 'success', runDirectory: run.inputDir })),
      ...failures,
    ],
  }, now);
}

function ledger(runs: WereadObservationSuccess[] = [], failures: DeclaredFailure[] = []): WereadObservationLedger {
  return buildWereadObservationLedger(declaration(runs, failures), runs, now);
}

describe('parseWereadObservations', () => {
  it('normalizes offset-equivalent instants without rewriting canonical success paths', () => {
    const result = parseWereadObservations({
      schemaVersion: 1,
      publisherIdentity,
      cutoffAt: '2026-10-08T19:00:00+08:00',
      attempts: [
        { outcome: 'success', runDirectory: '/restricted/runs/a' },
        { outcome: 'blocked', observedAt: '2026-10-08T07:00:00-04:00' },
      ],
    }, now);
    expect(result.cutoffAt).toBe(cutoffAt);
    expect(result.attempts).toEqual([
      { outcome: 'success', runDirectory: '/restricted/runs/a' },
      { outcome: 'blocked', observedAt: cutoffAt },
    ]);
  });

  it('accepts an empty declaration and the 1000-attempt boundary', () => {
    expect(declaration().attempts).toEqual([]);
    const input = declaration([], Array.from({ length: 1000 }, () => ({ outcome: 'empty', observedAt: first })));
    expect(input.attempts).toHaveLength(1000);
    expect(() => parseWereadObservations({ ...input, attempts: [...input.attempts, input.attempts[0]] }, now)).toThrow();
  });

  it('rejects duplicate completed-run declarations', () => {
    const run = success(1, first);
    const input = declaration([run]);
    expect(() => parseWereadObservations({
      ...input,
      attempts: [...input.attempts, { outcome: 'success', runDirectory: run.inputDir }],
    }, now)).toThrow(/Duplicate/);
  });

  it.each([
    { schemaVersion: 2 },
    { cookie: 'must-not-enter-ledger' },
    { attempts: [{ outcome: 'error', observedAt: first, reason: 'free-form error' }] },
    { attempts: [{ outcome: 'blocked', observedAt: first, token: 'must-not-enter-ledger' }] },
    { attempts: [{ outcome: 'empty', observedAt: first, runDirectory: '/restricted/a' }] },
    { attempts: [{ outcome: 'success', runDirectory: '/restricted/a', observedAt: first }] },
    { attempts: [{ outcome: 'success', runDirectory: 'relative/path' }] },
    { attempts: [{ outcome: 'success', runDirectory: '/restricted/\u0000a' }] },
    { attempts: [{ outcome: 'unknown', observedAt: first }] },
    { attempts: [{ outcome: 'error', observedAt: '2026-10-07T01:00:00' }] },
    { attempts: [{ outcome: 'error', observedAt: '2026-02-30T01:00:00Z' }] },
    { attempts: [{ outcome: 'error', observedAt: '2026-10-07T01:00:00.0001Z' }] },
    { attempts: [{ outcome: 'error' }] },
    { cutoffAt: 'not-a-time' },
    { publisherIdentity: { ...publisherIdentity, session: 'secret' } },
    { publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '1234567890' } },
    { publisherIdentity: { ...publisherIdentity, version: 2 } },
    { publisherIdentity: { ...publisherIdentity, value: 'MTIzNDU2Nzg5MA' } },
    { publisherIdentity: { ...publisherIdentity, value: Buffer.from('not-decimal').toString('base64') } },
    { publisherIdentity: { ...publisherIdentity, value: Buffer.from('0123').toString('base64') } },
  ])('rejects malformed or secret-bearing declaration %j', (patch) => {
    expect(() => parseWereadObservations({ ...declaration(), ...patch }, now)).toThrow();
  });

  it('rejects future cutoff, after-cutoff failures, and an invalid current clock', () => {
    expect(() => parseWereadObservations({ ...declaration(), cutoffAt: '2026-10-08T12:00:01Z' }, now)).toThrow(/future/);
    expect(() => declaration([], [{ outcome: 'error', observedAt: '2026-10-08T11:00:01Z' }])).toThrow(/cutoff/);
    expect(() => parseWereadObservations(declaration(), new Date(NaN))).toThrow(/clock/);
  });
});

describe('buildWereadObservationLedger', () => {
  it('qualifies native observations without granting publication, bundle, discovery, or benchmark authority', () => {
    const run = success(1, first);
    const result = ledger([run]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'weread-observation',
      source: { publisherIdentity, provider: { name: 'WeRSS', mode: 'weread_mp' } },
      cutoffAt,
      evidenceTier: 'restricted',
      publicationEligible: false,
      bundleEligible: false,
      benchmarkStarted: false,
      discovery: { complete: false, reason: 'weread-cover-latest-only' },
      scope: { successes: 'supplied-runs-only', failures: 'operator-declared-failures' },
      counts: {
        successfulRuns: 1, blockedAttempts: 0, errorAttempts: 0, emptyAttempts: 0,
        distinctNativeItems: 1, duplicateSightings: 0, publicationConflicts: 0,
      },
      lastObservation: { observedAt: first, outcomes: ['success'] },
      lastSuccessAt: first,
      progress: {
        kind: 'observed-native-items-only', cursor: null, coveredThrough: null,
        lastNewNativeItemAt: first,
        latestKnownPublication: { publishedAt: published, sourceItemIds: [run.sourceItemId] },
        eligible: true,
      },
    });
    expect(result.items[0]).toEqual({
      sourceItemId: run.sourceItemId,
      nativeIdentity: run.nativeIdentity,
      firstSeenAt: first,
      lastSeenAt: first,
      sightingCount: 1,
      contentSha256s: [run.contentSha256],
      contentVariantCount: 1,
      publicationTimes: [published],
      publicationConflict: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/Restricted synthetic title|synthetic body|providerReviewId|shadowItemId|coverUrl|contentHtml/);
  });

  it('deduplicates native IDs across provider aliases, versions, and changed content', () => {
    const original = success(1, first);
    const changed = success(2, second, {
      providerVersion: '2.0.0', reviewToken: 'anotherAliasToken', contentHtml: '<p>changed body</p>',
    });
    const repeated = success(3, third, { providerVersion: '3.0.0', reviewToken: 'thirdAliasToken' });
    expect(changed.sourceItemId).toBe(original.sourceItemId);
    const result = ledger([repeated, original, changed]);
    expect(result.counts).toMatchObject({ successfulRuns: 3, distinctNativeItems: 1, duplicateSightings: 2 });
    expect(result.items[0]).toMatchObject({
      firstSeenAt: first, lastSeenAt: third, sightingCount: 3, contentVariantCount: 2,
      contentSha256s: [original.contentSha256, changed.contentSha256].sort(),
    });
    expect(result.lastSuccessAt).toBe(third);
    expect(result.progress.lastNewNativeItemAt).toBe(first);
    expect(result.progress.latestKnownPublication?.publishedAt).toBe(published);
  });

  it('is independent of declaration and summary order, including tied acquisition clocks', () => {
    const one = success(1, first);
    const two = success(2, first, { mid: '10002' });
    const three = success(3, second, { mid: '10003' });
    two.completedAt = '2026-10-07T01:00:03Z';
    const forward = buildWereadObservationLedger(declaration([one, two, three]), [one, two, three], now);
    const reverse = buildWereadObservationLedger(declaration([three, two, one]), [two, three, one], now);
    expect(reverse).toEqual(forward);
    expect(forward.progress.lastNewNativeItemAt).toBe(second);
    expect(forward.progress.latestKnownPublication?.sourceItemIds).toEqual([one.sourceItemId, two.sourceItemId, three.sourceItemId].sort());
  });

  it('does not use later replay completion to fabricate upstream success or recovery', () => {
    const replay = success(1, first);
    replay.startedAt = '2026-10-08T09:00:00Z';
    replay.completedAt = '2026-10-08T10:00:00Z';
    const result = ledger([replay], [{ outcome: 'blocked', observedAt: second }]);
    expect(result.lastSuccessAt).toBe(first);
    expect(result.lastObservation).toEqual({ observedAt: second, outcomes: ['blocked'] });
    expect(result.progress.lastNewNativeItemAt).toBe(first);
  });

  it('recovers after declared blocked, error, and empty attempts while keeping failures out of progress', () => {
    const run = success(1, third);
    const recovered = ledger([run], [
      { outcome: 'blocked', observedAt: first },
      { outcome: 'error', observedAt: second },
      { outcome: 'empty', observedAt: '2026-10-07T02:30:00Z' },
    ]);
    expect(recovered.counts).toMatchObject({ blockedAttempts: 1, errorAttempts: 1, emptyAttempts: 1 });
    expect(recovered.lastObservation).toEqual({ observedAt: third, outcomes: ['success'] });
    expect(recovered.lastSuccessAt).toBe(third);
    expect(recovered.progress.eligible).toBe(true);
    const failedLater = ledger([run], [{ outcome: 'error', observedAt: '2026-10-07T04:00:00Z' }]);
    expect(failedLater.lastObservation).toEqual({ observedAt: '2026-10-07T04:00:00.000Z', outcomes: ['error'] });
    expect(failedLater.lastSuccessAt).toBe(recovered.lastSuccessAt);
    expect(failedLater.progress).toEqual(recovered.progress);
  });

  it('records unique, sorted outcomes at the latest equivalent instant', () => {
    const run = success(1, third);
    const result = ledger([run], [
      { outcome: 'empty', observedAt: '2026-10-07T11:00:00+08:00' },
      { outcome: 'error', observedAt: third },
      { outcome: 'blocked', observedAt: '2026-10-06T23:00:00-04:00' },
      { outcome: 'error', observedAt: third },
      { outcome: 'empty', observedAt: first },
    ]);
    expect(result.lastObservation).toEqual({ observedAt: third, outcomes: ['blocked', 'empty', 'error', 'success'] });
    expect(result.counts.errorAttempts).toBe(2);
  });

  it('retains newest publication and every tied ID when a later observation discovers an older item', () => {
    const newest = success(1, first, { mid: '10001', publishedAt: '2026-10-06T18:00:00Z' });
    const tied = success(2, second, { mid: '10002', publishedAt: '2026-10-06T18:00:00Z' });
    const older = success(3, third, { mid: '10003', publishedAt: '2026-10-05T18:00:00Z' });
    const result = ledger([older, newest, tied]);
    expect(result.progress.lastNewNativeItemAt).toBe(third);
    expect(result.progress.latestKnownPublication).toEqual({
      publishedAt: '2026-10-06T18:00:00.000Z', sourceItemIds: [newest.sourceItemId, tied.sourceItemId].sort(),
    });
    expect(result.counts.distinctNativeItems).toBe(3);
  });

  it('distinguishes sibling native articles with the same mid and different idx', () => {
    const one = success(1, first, { idx: 1 });
    const two = success(2, second, { idx: 2 });
    const result = ledger([one, two]);
    expect(result.counts.distinctNativeItems).toBe(2);
    expect(result.progress.latestKnownPublication?.sourceItemIds).toEqual([one.sourceItemId, two.sourceItemId].sort());
  });

  it('keeps empty and failure-only ledgers without invented progress', () => {
    const empty = ledger();
    expect(empty.items).toEqual([]);
    expect(empty.lastObservation).toBeNull();
    expect(empty.lastSuccessAt).toBeNull();
    expect(empty.progress).toEqual({
      kind: 'observed-native-items-only', cursor: null, coveredThrough: null,
      lastNewNativeItemAt: null, latestKnownPublication: null, eligible: false,
    });
    const failed = ledger([], [
      { outcome: 'blocked', observedAt: first },
      { outcome: 'error', observedAt: second },
      { outcome: 'empty', observedAt: third },
    ]);
    expect(failed.counts).toEqual({
      successfulRuns: 0, blockedAttempts: 1, errorAttempts: 1, emptyAttempts: 1,
      distinctNativeItems: 0, duplicateSightings: 0, publicationConflicts: 0,
    });
    expect(failed.lastObservation).toEqual({ observedAt: third, outcomes: ['empty'] });
    expect(failed.lastSuccessAt).toBeNull();
    expect(failed.progress).toEqual(empty.progress);
  });

  it('suppresses all publication progress for a conflicting native publication timestamp', () => {
    const one = success(1, first);
    const conflict = success(2, second, { publishedAt: '2026-10-06T13:00:00Z' });
    const unrelatedNewer = success(3, third, { mid: '10002', publishedAt: '2026-10-06T20:00:00Z' });
    const result = ledger([unrelatedNewer, conflict, one]);
    expect(result.counts.publicationConflicts).toBe(1);
    expect(result.items.find((item) => item.sourceItemId === one.sourceItemId)).toMatchObject({
      firstSeenAt: first, lastSeenAt: second, sightingCount: 2, publicationConflict: true,
      publicationTimes: [published, '2026-10-06T13:00:00.000Z'],
    });
    expect(result.progress.latestKnownPublication).toBeNull();
    expect(result.progress.eligible).toBe(false);
    expect(result.progress.lastNewNativeItemAt).toBe(third);
  });

  it('accepts offset-equivalent publication clocks without declaring a conflict', () => {
    const one = success(1, first);
    const two = success(2, second);
    two.publicationTime.normalizedAt = '2026-10-06T20:00:00+08:00';
    two.acquiredAt = '2026-10-07T10:00:00+08:00';
    const result = ledger([one, two]);
    expect(result.counts.publicationConflicts).toBe(0);
    expect(result.items[0]?.publicationTimes).toEqual([published]);
    expect(result.lastSuccessAt).toBe(second);
    expect(result.progress.eligible).toBe(true);
  });

  it('requires exactly one summary for each declared success and globally unique run IDs', () => {
    const one = success(1, first);
    const two = success(2, second);
    expect(() => buildWereadObservationLedger(declaration([one]), [], now)).toThrow(/every declared success/);
    expect(() => buildWereadObservationLedger(declaration(), [one], now)).toThrow(/every declared success/);
    expect(() => buildWereadObservationLedger(declaration([one]), [two], now)).toThrow(/unexpected/);
    expect(() => buildWereadObservationLedger(declaration([one, two]), [one, one], now)).toThrow(/duplicate/);
    expect(() => buildWereadObservationLedger(declaration([one, two]), [one, { ...two, runId: one.runId }], now)).toThrow(/duplicate/);
  });

  it('rejects foreign publishers, mismatched native IDs, and malformed native identity', () => {
    const one = success(1, first);
    const foreign = success(1, first, { publisher: Buffer.from('9876543210').toString('base64') });
    const input = declaration([one]);
    expect(() => buildWereadObservationLedger(input, [foreign], now)).toThrow(/foreign/);
    expect(() => buildWereadObservationLedger(input, [{ ...one, nativeIdentity: { ...one.nativeIdentity, mid: '10002' } }], now)).toThrow(/native identity/);
    expect(() => buildWereadObservationLedger(input, [{ ...one, sourceItemId: `social-native-v1:${'b'.repeat(64)}` }], now)).toThrow(/native identity/);
    expect(() => buildWereadObservationLedger(input, [{ ...one, nativeIdentity: { ...one.nativeIdentity, mid: '0001' } }], now)).toThrow();
  });

  it.each([
    { acquiredAt: '2026-10-07T01:00:02Z' },
    { startedAt: '2026-10-07T00:59:59Z' },
    { startedAt: '2026-10-07T01:00:03Z' },
    { completedAt: '2026-10-07T00:59:59Z' },
    { completedAt: '2026-10-08T11:00:01Z' },
    { completedAt: '2026-10-08T12:00:01Z' },
    { acquiredAt: '2026-10-06T11:59:59Z' },
    { acquiredAt: '2026-10-07T01:00:00' },
    { acquiredAt: '2026-10-07T01:00:00.0001Z' },
    { startedAt: 'invalid-time' },
  ])('rejects impossible acquisition clocks %j', (patch) => {
    const one = success(1, first);
    expect(() => buildWereadObservationLedger(declaration([one]), [{ ...one, ...patch }], now)).toThrow();
  });

  it('allows equality at every clock boundary through cutoff and now', () => {
    const one = success(1, published);
    one.startedAt = published;
    one.completedAt = published;
    const input = { ...declaration([one]), cutoffAt: published };
    expect(buildWereadObservationLedger(input, [one], new Date(published)).progress.eligible).toBe(true);
  });

  it('validates typed callers instead of trusting bypassed declaration and summary types', () => {
    const one = success(1, first);
    const input = declaration([one]);
    const secretInput = { ...input, token: 'must-not-enter-ledger' } as WereadObservations;
    expect(() => buildWereadObservationLedger(secretInput, [one], now)).toThrow(/declaration/);
    expect(() => buildWereadObservationLedger({ ...input, cutoffAt: '2026-10-09T00:00:00Z' }, [one], now)).toThrow(/future/);
    expect(() => buildWereadObservationLedger({
      ...input, attempts: [...input.attempts, { outcome: 'error', observedAt: '2026-10-08T11:01:00Z' }],
    }, [one], now)).toThrow(/cutoff/);
    const secretSummary = { ...one, cookie: 'must-not-enter-ledger' } as WereadObservationSuccess;
    expect(() => buildWereadObservationLedger(input, [secretSummary], now)).toThrow(/summaries/);
    expect(() => buildWereadObservationLedger(input, [{ ...one, manifestSha256: 'not-a-hash' }], now)).toThrow();
    expect(() => buildWereadObservationLedger(input, [{ ...one, runId: 'not-a-run-id' }], now)).toThrow();
    expect(() => buildWereadObservationLedger(input, [{ ...one, contentSha256: 'A'.repeat(64) }], now)).toThrow();
    expect(() => buildWereadObservationLedger(input, [{ ...one, inputDir: `${one.inputDir}/` }], now)).toThrow(/summaries/);
    expect(() => buildWereadObservationLedger(input, [one], new Date(NaN))).toThrow(/clock/);
  });

  it('rejects opaque, contradictory, or secret-bearing publication evidence', () => {
    const one = success(1, first);
    const input = declaration([one]);
    const contradictory = { ...one, publicationTime: { ...one.publicationTime, normalizedAt: third } };
    expect(() => buildWereadObservationLedger(input, [contradictory], now)).toThrow(/summaries/);
    const unknown = {
      ...one,
      publicationTime: { original: null, precision: 'unknown', timezone: null, normalizedAt: null, publishedOn: null },
    } as WereadObservationSuccess;
    expect(() => buildWereadObservationLedger(input, [unknown], now)).toThrow(/summaries/);
    const secret = {
      ...one,
      publicationTime: { ...one.publicationTime, original: { ...one.publicationTime.original, token: 'secret' } },
    } as WereadObservationSuccess;
    expect(() => buildWereadObservationLedger(input, [secret], now)).toThrow(/summaries/);
    const future = success(1, first, { publishedAt: second });
    expect(() => buildWereadObservationLedger(input, [future], now)).toThrow(/clock ordering/);
  });
});
