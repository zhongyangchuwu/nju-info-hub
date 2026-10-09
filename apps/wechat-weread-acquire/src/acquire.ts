import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertAbsoluteRuntime, type WereadAcquireRuntime } from './config.js';
import { normalizeWereadLatest } from './normalize.js';
import { parseWechatSourcePolicy } from './policy.js';
import { buildWereadShadowBundle } from './shadow.js';
import { readIsolatedJson, restrictedRoot } from './storage.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function acquireWereadLatest(runtimeInput: WereadAcquireRuntime): Promise<{
  runId: string;
  shadowItemId: string;
  sourceItemId: string;
  bundleEligible: false;
  publicationEligible: false;
  shadowBundleCreated: boolean;
}> {
  const runtime = assertAbsoluteRuntime(runtimeInput);
  const root = await restrictedRoot(runtime.outputRoot, runtime.protectedRoot);
  const providerExport = await readIsolatedJson(runtime.inputPath, runtime.protectedRoot);
  const candidate = normalizeWereadLatest(providerExport.value);

  const runId = randomUUID();
  const now = new Date();
  const startedAt = now.toISOString();
  const sourcePolicy = runtime.sourcePolicyPath === undefined ? null : parseWechatSourcePolicy(
    (await readIsolatedJson(runtime.sourcePolicyPath, runtime.protectedRoot)).value,
    now,
  );
  const shadow = sourcePolicy === null ? null : buildWereadShadowBundle(candidate, sourcePolicy, runId, now);
  const staging = await mkdtemp(path.join(root, '.partial-'));
  await mkdir(path.join(staging, 'blobs'), { mode: 0o700 });

  const rawSha256 = sha256(providerExport.bytes);
  await writeFile(path.join(staging, 'blobs', rawSha256), providerExport.bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(
    path.join(staging, 'candidate.json'),
    JSON.stringify(candidate, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );

  if (shadow !== null) {
    const publicSafe = path.join(staging, 'public-safe');
    await mkdir(publicSafe, { mode: 0o700 });
    await mkdir(path.join(publicSafe, 'blobs'), { mode: 0o700 });
    await writeFile(path.join(publicSafe, 'blobs', sha256(shadow.metadataBytes)), shadow.metadataBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(publicSafe, 'bundle.json'), JSON.stringify(shadow.bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Qualification evidence remains operator-only, outside the public-safe projection.
    await writeFile(path.join(staging, 'source-policy.json'), JSON.stringify(sourcePolicy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }

  const manifest = {
    schemaVersion: 2,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    evidenceTier: 'restricted',
    publicationEligible: false,
    bundleIdentityEligible: true,
    bundleEligible: false,
    shadowBundle: shadow === null ? null : {
      path: 'public-safe/bundle.json',
      decisionStatus: 'review-required',
      policyVersion: shadow.bundle.envelopes[0]!.decision.policyVersion,
    },
    identityStatus: 'complete',
    missingNativeIdentity: [],
    discovery: candidate.discovery,
    candidate: {
      shadowItemId: candidate.shadowItemId,
      sourceItemId: candidate.item.sourceItemId,
      providerFeedId: candidate.source.providerFeedId,
      providerReviewId: candidate.item.providerReviewId,
    },
    rawEvidence: {
      sha256: rawSha256,
      contentType: 'application/json; charset=utf-8',
      byteLength: providerExport.bytes.byteLength,
      evidenceKind: 'provider-export',
      sanitizationVersion: 'werss-weread-positive-export-v2',
    },
    provenance: candidate.provenance,
  };
  await writeFile(path.join(staging, 'run.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(staging, path.join(root, runId));

  return {
    runId,
    shadowItemId: candidate.shadowItemId,
    sourceItemId: candidate.item.sourceItemId,
    bundleEligible: false,
    publicationEligible: false,
    shadowBundleCreated: shadow !== null,
  };
}
