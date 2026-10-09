import type { SocialAcquisitionBundle, SocialEnvelopePayload } from './social-acquisition.js';

export interface SocialTrustKey {
  id: string;
  /** Canonical base64 Ed25519 SPKI DER; public material only. */
  publicKey: string;
}

export interface SocialTrustedSource {
  policy: SocialEnvelopePayload['source'];
  organization: { id: string; name: string };
  homepageUrl: string;
  qualification: {
    owner: string;
    publicAudienceEvidence: string;
    allowedContentScope: 'link-only';
    redistributionBasis: string;
    reviewedAt: string;
    reviewUntil: string;
  };
  producerIds: string[];
  approverIds: string[];
}

export interface SocialImportTrust {
  schemaVersion: 1;
  producers: SocialTrustKey[];
  approvers: SocialTrustKey[];
  sources: SocialTrustedSource[];
}

export interface SocialProducerReceipt {
  sha256: string;
  producerId: string;
  signature: string;
}

export type SocialImportAction = 'publish' | 'restore' | 'suppress' | 'revoke-source';

export interface SocialImportOperation {
  schemaVersion: 1;
  operationId: string;
  sourceId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  policySha256: string;
  approverId: string;
  action: SocialImportAction;
  bundle: SocialProducerReceipt | null;
  sourceItemIds: string[];
  reasonCode: 'approved-metadata' | 'correction' | 'withdrawal' | 'source-revocation';
}

export interface SignedSocialImportOperation {
  operation: SocialImportOperation;
  signature: string;
}

/** Untrusted transport input: the database applies only after cryptographic verification. */
export interface SocialImportInput {
  trust: unknown;
  authorization: unknown;
  bundleBytes: Buffer | null;
  blobs: ReadonlyMap<string, Buffer>;
}

export interface VerifiedSocialImport {
  operation: SocialImportOperation;
  operationSha256: string;
  authorizationBytes: Buffer;
  source: SocialTrustedSource;
  bundle: SocialAcquisitionBundle | null;
  bundleBytes: Buffer | null;
  blobs: ReadonlyMap<string, Buffer>;
}

export interface SocialImportResult {
  status: 'applied' | 'replayed';
  sourceId: string;
  sequence: number;
  action: SocialImportAction;
  importedItems: number;
  suppressedItems: number;
}

/** Public projection only; signatures, operator identity, reasons and trust material stay private. */
export interface SocialEntryMetadata {
  platform: SocialEnvelopePayload['source']['platform'];
  publisherIdentity: SocialEnvelopePayload['source']['publisherIdentity'];
  role: SocialEnvelopePayload['source']['role'];
  nativeIdentity: SocialEnvelopePayload['item']['nativeIdentity'];
  publicationTime: SocialEnvelopePayload['publicationTime'];
  attribution: SocialEnvelopePayload['attribution'];
  policyVersion: string;
  revisionNumber: number;
}

export interface SocialPublicationState {
  status: 'active' | 'revoked' | 'expired';
  changedAt: string;
}
