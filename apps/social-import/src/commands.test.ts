import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  socialEnvelopePayloadSchema, socialPublicationBinding, socialSourceItemId, socialTrustedSourceSha256,
  type SocialAcquisitionBundle, type SocialEnvelopePayload, type SocialImportOperation,
  type SocialImportTrust, type SocialProducerReceipt,
} from '@nju-info/core';
import { InfoHubDatabaseReader } from '@nju-info/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeSocialImport, importSocialMetadata, signSocialProducerBundle,
  type SocialImportFiles,
} from './commands.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface OperatorFixture {
  root: string;
  files: SocialImportFiles;
  producerKey: string;
  approverKey: string;
  operationFile: string;
  receiptFile: string;
  operation: SocialImportOperation;
  blobFile: string;
  now: Date;
}

async function fixture(): Promise<OperatorFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'nju-social-import-test-'));
  roots.push(root);
  const now = new Date();
  const before = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
  for (const directory of ['control', 'keys', 'producer', 'database', 'producer/public-safe', 'producer/public-safe/blobs']) {
    await mkdir(path.join(root, directory), { mode: 0o700 });
  }
  const producer = generateKeyPairSync('ed25519');
  const approver = generateKeyPairSync('ed25519');
  const producerKey = path.join(root, 'keys/producer.pem');
  const approverKey = path.join(root, 'keys/approver.pem');
  await writeFile(producerKey, producer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(approverKey, approver.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const source: SocialEnvelopePayload['source'] = {
    sourceId: 'synthetic-operator-relay', platform: 'qzone',
    publisherIdentity: { scheme: 'qzone-uin', version: 1, value: '123456789' },
    displayName: 'Synthetic relay', role: 'relay', access: 'credentialed-public', audience: 'public',
    redistributionMode: 'review-only', policyVersion: 'synthetic-policy',
  };
  const nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity'] = { scheme: 'qzone-tid', version: 1, tid: 'synthetic-post' };
  const payload = socialEnvelopePayloadSchema.parse({
    source,
    item: {
      nativeIdentity, sourceItemId: socialSourceItemId({ platform: 'qzone', publisher: source.publisherIdentity, item: nativeIdentity }),
      originalUrl: 'https://public.example/post', canonicalUrl: 'https://public.example/post', aliases: [],
    },
    publicationTime: {
      original: { value: before(180), representation: 'iso8601' }, precision: 'millisecond', timezone: 'UTC',
      normalizedAt: before(180), publishedOn: before(180).slice(0, 10),
    },
    content: { title: 'Synthetic public title', text: '', html: '', completeness: 'link-only' },
    media: [], attachments: [], attribution: { relationship: 'unknown', verification: 'unknown', origin: null, evidence: [] },
    rawBlobs: [{
      blob: { sha256: '0'.repeat(64), byteLength: 0, contentType: 'application/json; charset=utf-8' },
      sourceUrl: 'https://public.example/post', acquiredAt: before(120),
      evidenceTier: 'public-safe', evidenceKind: 'provider-export', sanitizationVersion: 'qzone-link-metadata-v1',
    }],
  });
  const metadata = Buffer.from(JSON.stringify({
    schemaVersion: 1, sanitizationVersion: 'qzone-link-metadata-v1', platform: source.platform,
    publisherIdentity: payload.source.publisherIdentity, item: payload.item, publicationTime: payload.publicationTime,
    content: payload.content, attribution: payload.attribution,
  }) + '\n');
  const hash = createHash('sha256').update(metadata).digest('hex');
  payload.rawBlobs[0]!.blob = { sha256: hash, byteLength: metadata.length, contentType: 'application/json; charset=utf-8' };
  const bundle: SocialAcquisitionBundle = {
    schemaVersion: 1, bundleId: 'synthetic-bundle', envelopes: [{
      schemaVersion: 1, payload,
      provenance: {
        acquiredAt: before(120), method: 'credentialed-public-export',
        provider: { name: 'synthetic', version: '1' }, exporter: { name: 'synthetic', version: '1' }, runId: 'synthetic-run',
      },
      decision: {
        status: 'review-required', mode: 'none', method: 'item-review', policyVersion: source.policyVersion,
        decidedAt: before(90), reason: 'Synthetic pending transport', binding: socialPublicationBinding(payload),
      },
    }],
  };
  const files: SocialImportFiles = {
    trust: path.join(root, 'control/trust.json'), authorization: path.join(root, 'control/authorization.json'),
    bundleDirectory: path.join(root, 'producer/public-safe'), database: path.join(root, 'database/hub.sqlite'),
    protectedRoot: path.join(root, 'never-inspected-provider-state'),
  };
  const blobFile = path.join(files.bundleDirectory!, 'blobs', hash);
  await writeFile(blobFile, metadata, { mode: 0o600 });
  await writeFile(path.join(files.bundleDirectory!, 'bundle.json'), JSON.stringify(bundle) + '\n', { mode: 0o600 });
  const trust: SocialImportTrust = {
    schemaVersion: 1,
    producers: [{ id: 'synthetic-producer', publicKey: producer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    approvers: [{ id: 'synthetic-approver', publicKey: approver.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    sources: [{
      policy: source, organization: { id: 'synthetic-org', name: 'Synthetic organization' }, homepageUrl: 'https://public.example/',
      qualification: {
        owner: 'Synthetic operator', publicAudienceEvidence: 'Synthetic public audience', allowedContentScope: 'link-only',
        redistributionBasis: 'Synthetic metadata-only permission', reviewedAt: before(360),
        reviewUntil: new Date(now.getTime() + 86400_000).toISOString(),
      },
      producerIds: ['synthetic-producer'], approverIds: ['synthetic-approver'],
    }],
  };
  await writeFile(files.trust, JSON.stringify(trust), { mode: 0o600 });
  const receiptFile = path.join(root, 'control/receipt.json');
  await signSocialProducerBundle({ bundleDirectory: files.bundleDirectory!, producerId: 'synthetic-producer',
    privateKey: producerKey, output: receiptFile, protectedRoot: files.protectedRoot });
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as SocialProducerReceipt;
  const operation: SocialImportOperation = {
    schemaVersion: 1, operationId: randomUUID(), sourceId: source.sourceId, sequence: 1,
    issuedAt: before(60), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    policySha256: socialTrustedSourceSha256(trust.sources[0]!), approverId: 'synthetic-approver', action: 'publish',
    bundle: receipt, sourceItemIds: [], reasonCode: 'approved-metadata',
  };
  const operationFile = path.join(root, 'control/operation.json');
  await writeFile(operationFile, JSON.stringify(operation), { mode: 0o600 });
  await authorizeSocialImport({ trust: files.trust, operation: operationFile, privateKey: approverKey,
    output: files.authorization, protectedRoot: files.protectedRoot });
  return { root, files, producerKey, approverKey, operationFile, receiptFile, operation, blobFile, now };
}

function publicEntries(database: string) {
  const reader = new InfoHubDatabaseReader(database);
  try {
    return reader.listRecentSourceEntries();
  } finally {
    reader.close();
  }
}

describe('private authenticated operator boundary', () => {
  it('publishes real signed metadata into a private database and replays without replacing evidence', async () => {
    const data = await fixture();
    expect((await importSocialMetadata(data.files, data.now)).status).toBe('applied');
    const entries = publicEntries(data.files.database);
    expect(entries.map((entry) => [entry.title, entry.social?.role, entry.social?.revisionNumber]))
      .toEqual([['Synthetic public title', 'relay', 1]]);
    expect((await lstat(data.files.database)).mode & 0o077).toBe(0);
    for (const filename of await readdir(path.dirname(data.files.database))) {
      expect((await lstat(path.join(path.dirname(data.files.database), filename))).mode & 0o077).toBe(0);
      expect(filename.startsWith('.partial')).toBe(false);
    }
    expect((await importSocialMetadata(data.files, data.now)).status).toBe('replayed');
    expect(publicEntries(data.files.database)).toEqual(entries);
  });

  it('does not create a selected database for authenticated but invalid restoration', async () => {
    const data = await fixture();
    data.operation.action = 'restore';
    const output = path.join(data.root, 'control/restore.json');
    await writeFile(data.operationFile, JSON.stringify(data.operation), { mode: 0o600 });
    await authorizeSocialImport({ trust: data.files.trust, operation: data.operationFile, privateKey: data.approverKey,
      output, protectedRoot: data.files.protectedRoot });
    await expect(importSocialMetadata({ ...data.files, authorization: output }, data.now)).rejects.toThrow(/existing suppression/);
    expect(await readdir(path.dirname(data.files.database))).toEqual([]);
  });

  it.each(['symlink', 'hardlink', 'public-file', 'changed-blob'] as const)('rejects %s input without changing committed publication', async (attack) => {
    const data = await fixture();
    await importSocialMetadata(data.files, data.now);
    const entries = publicEntries(data.files.database);
    const copy = path.join(data.root, 'control/alternate-trust.json');
    if (attack === 'symlink') await symlink(data.files.trust, copy);
    if (attack === 'hardlink') await link(data.files.trust, copy);
    if (attack === 'public-file') await chmod(data.files.trust, 0o644);
    if (attack === 'changed-blob') await writeFile(data.blobFile, 'private-secret-bearing-provider-response', { mode: 0o600 });
    await expect(importSocialMetadata({ ...data.files, trust: attack === 'symlink' || attack === 'hardlink' ? copy : data.files.trust }, data.now))
      .rejects.toThrow();
    expect(publicEntries(data.files.database)).toEqual(entries);
  });

  it('refuses producer self-approval and output replacement', async () => {
    const data = await fixture();
    const output = path.join(data.root, 'control/wrong-key.json');
    await expect(authorizeSocialImport({ trust: data.files.trust, operation: data.operationFile, privateKey: data.producerKey,
      output, protectedRoot: data.files.protectedRoot })).rejects.toThrow(/trusted approver/);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    const original = await readFile(data.files.authorization);
    await expect(authorizeSocialImport({ trust: data.files.trust, operation: data.operationFile, privateKey: data.approverKey,
      output: data.files.authorization, protectedRoot: data.files.protectedRoot })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(data.files.authorization)).toEqual(original);
  });

  it('rejects protected namespaces before probing an inaccessible declared root', async () => {
    const data = await fixture();
    const protectedRoot = path.join(data.root, 'inaccessible');
    await mkdir(protectedRoot, { mode: 0o000 });
    try {
      await expect(importSocialMetadata({ ...data.files, protectedRoot,
        trust: path.join(protectedRoot, 'never-opened.json') }, data.now)).rejects.toThrow(/boundary/);
      expect(await readdir(path.dirname(data.files.database))).toEqual([]);
    } finally {
      await chmod(protectedRoot, 0o700);
    }
  });

  it('redacts rejected CLI payloads and never creates its selected database', async () => {
    const data = await fixture();
    const secret = 'synthetic-private-cookie-secret';
    await writeFile(data.files.authorization, JSON.stringify({ secret }), { mode: 0o600 });
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', 'apps/social-import/src/cli.ts', 'import', data.files.trust, data.files.authorization,
        data.files.bundleDirectory!, data.files.database],
      { cwd: repositoryRoot, encoding: 'utf8', env: {
        PATH: process.env.PATH,
        SOCIAL_IMPORT_PROTECTED_ROOT: data.files.protectedRoot,
      } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Social import command rejected.');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(data.root);
    expect(await readdir(path.dirname(data.files.database))).toEqual([]);
  });
});
