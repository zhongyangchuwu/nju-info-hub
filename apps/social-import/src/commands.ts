import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { link, lstat, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  parseSocialAcquisitionBundle,
  parseSocialImportOperation,
  parseSocialImportTrust,
  parseSocialImportJson,
  socialImportLimits,
  socialImportOperationBytes,
  parseSignedSocialImportOperation,
  socialProducerReceiptBytes,
  socialTrustedSourceSha256,
  verifySocialImport,
  type SignedSocialImportOperation,
  type SocialImportInput,
  type SocialImportResult,
  type SocialProducerReceipt,
} from '@nju-info/core';
import { InfoHubDatabase } from '@nju-info/db';
import { operatorPaths, privateBytes, privateDatabase, privateJson, privateWrite } from './storage.js';

export interface SocialImportFiles {
  trust: string;
  authorization: string;
  bundleDirectory: string | null;
  database: string;
  protectedRoot: string;
}

async function bundleInput(directory: string, expectedSha256: string): Promise<{ bytes: Buffer; blobs: Map<string, Buffer> }> {
  const bytes = await privateBytes(path.join(directory, 'bundle.json'), socialImportLimits.maxBundleBytes);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Bundle receipt hash mismatch');
  const bundle = parseSocialAcquisitionBundle(parseSocialImportJson(bytes));
  if (bundle.envelopes.length > socialImportLimits.maxItems) throw new Error('Too many metadata envelopes');
  const blobs = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const { payload } of bundle.envelopes) {
    // The importer never opens restricted evidence or assets, including rejected full packets.
    if (payload.content.completeness !== 'link-only' || payload.rawBlobs.length !== 1 ||
        payload.media.length !== 0 || payload.attachments.length !== 0) {
      throw new Error('Only public-safe metadata transport is supported');
    }
    const descriptor = payload.rawBlobs[0]!.blob;
    if (!blobs.has(descriptor.sha256)) {
      const maximumBytes = Math.min(socialImportLimits.maxBlobBytes, socialImportLimits.maxTotalBlobBytes - totalBytes);
      if (descriptor.byteLength > maximumBytes) throw new Error('Metadata transport byte limit exceeded');
      const metadata = await privateBytes(path.join(directory, 'blobs', descriptor.sha256), maximumBytes);
      totalBytes += metadata.length;
      blobs.set(descriptor.sha256, metadata);
    }
  }
  return { bytes, blobs };
}

export async function importSocialMetadata(files: SocialImportFiles, now = new Date()): Promise<SocialImportResult> {
  await operatorPaths(files.bundleDirectory === null ? [] : [files.bundleDirectory],
    [files.trust, files.authorization], files.database, files.protectedRoot, true);
  const trust = await privateJson(files.trust);
  const authorization = parseSignedSocialImportOperation(await privateJson(files.authorization));
  const needsBundle = authorization.operation.action === 'publish' || authorization.operation.action === 'restore';
  if (needsBundle !== (files.bundleDirectory !== null)) throw new Error('Operation bundle argument mismatch');
  const bundle = files.bundleDirectory === null ? null : await bundleInput(files.bundleDirectory, authorization.operation.bundle!.sha256);
  const input: SocialImportInput = {
    trust,
    authorization,
    bundleBytes: bundle?.bytes ?? null,
    blobs: bundle?.blobs ?? new Map(),
  };
  // Preflight precedes database creation/migration; the DB independently verifies its own boundary.
  verifySocialImport(input, now);
  let exists = false;
  try {
    await lstat(files.database);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const filename = exists ? files.database : path.join(path.dirname(files.database), `.partial-social-${randomUUID()}.sqlite`);
  await privateDatabase(files.database);
  try {
    let result: SocialImportResult;
    const oldUmask = process.umask(0o077);
    try {
      const database = new InfoHubDatabase(filename);
      try {
        result = database.applySocialImport(input, now);
      } finally {
        database.close();
      }
    } finally {
      process.umask(oldUmask);
    }
    await privateDatabase(filename);
    if (!exists) {
      // A committed new DB becomes visible atomically; never replace a competing operator DB.
      await link(filename, files.database);
      await unlink(filename);
    }
    return result;
  } finally {
    if (!exists) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(filename + suffix, { force: true });
    }
  }
}

async function ed25519PrivateKey(filename: string): Promise<KeyObject> {
  const bytes = await privateBytes(filename);
  try {
    const key = createPrivateKey({ key: bytes, format: bytes[0] === 0x2d ? 'pem' : 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required');
    return key;
  } finally {
    bytes.fill(0);
  }
}

export interface SocialProducerSignFiles {
  bundleDirectory: string;
  producerId: string;
  privateKey: string;
  output: string;
  protectedRoot: string;
}

/** Transport attestation only. This command does not grant publication authority. */
export async function signSocialProducerBundle(files: SocialProducerSignFiles): Promise<void> {
  await operatorPaths([files.bundleDirectory], [files.privateKey], files.output, files.protectedRoot);
  const bytes = await privateBytes(path.join(files.bundleDirectory, 'bundle.json'), socialImportLimits.maxBundleBytes);
  parseSocialAcquisitionBundle(parseSocialImportJson(bytes));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const preimage = socialProducerReceiptBytes(files.producerId, sha256);
  const receipt: SocialProducerReceipt = {
    sha256,
    producerId: files.producerId,
    signature: sign(null, preimage, await ed25519PrivateKey(files.privateKey)).toString('base64'),
  };
  await privateWrite(files.output, receipt);
}

export interface SocialAuthorizeFiles {
  trust: string;
  operation: string;
  privateKey: string;
  output: string;
  protectedRoot: string;
}

/** Explicit operator signing, not automated rights/audience review or producer self-approval. */
export async function authorizeSocialImport(files: SocialAuthorizeFiles): Promise<void> {
  await operatorPaths([], [files.trust, files.operation, files.privateKey], files.output, files.protectedRoot);
  const trust = parseSocialImportTrust(await privateJson(files.trust));
  const operation = parseSocialImportOperation(await privateJson(files.operation));
  const source = trust.sources.find((entry) => entry.policy.sourceId === operation.sourceId);
  const approver = trust.approvers.find((entry) => entry.id === operation.approverId);
  if (source === undefined || approver === undefined || !source.approverIds.includes(approver.id) ||
      socialTrustedSourceSha256(source) !== operation.policySha256) {
    throw new Error('Operation does not match current operator trust');
  }
  const key = await ed25519PrivateKey(files.privateKey);
  if (createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== approver.publicKey) {
    throw new Error('Private key does not match the trusted approver');
  }
  const authorization: SignedSocialImportOperation = {
    operation,
    signature: sign(null, socialImportOperationBytes(operation), key).toString('base64'),
  };
  await privateWrite(files.output, authorization);
}
