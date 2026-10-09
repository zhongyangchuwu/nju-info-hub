import type { WereadLatestCandidate } from './normalize.js';

/** Compact verified evidence only; provider bodies and aliases never enter the ledger. */
export interface WereadObservationSuccess {
  inputDir: string;
  runId: string;
  manifestSha256: string;
  publisherIdentity: WereadLatestCandidate['source']['publisherIdentity'];
  startedAt: string;
  completedAt: string;
  acquiredAt: string;
  sourceItemId: string;
  nativeIdentity: WereadLatestCandidate['item']['nativeIdentity'];
  publicationTime: WereadLatestCandidate['item']['publicationTime'];
  contentSha256: string;
}
