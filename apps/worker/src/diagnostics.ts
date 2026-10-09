import type {
  CollectionErrorDiagnostic,
  CollectionPhase,
} from "@nju-info/core";

const MAX_CAUSES = 8;
const COLLECTION_PHASES: Record<CollectionPhase, true> = {
  "list-fetch": true,
  "list-parse": true,
  discovery: true,
  "detail-fetch": true,
  "detail-parse": true,
  persistence: true,
  collection: true,
};
const SAFE_ERROR_NAMES: Record<string, true> = {
  Error: true,
  TypeError: true,
  RangeError: true,
  ReferenceError: true,
  SyntaxError: true,
  URIError: true,
  EvalError: true,
  AggregateError: true,
  AbortError: true,
  TimeoutError: true,
  CollectionStageError: true,
  HttpStatusError: true,
  RestrictedDetailError: true,
  UnsupportedDetailAcquisitionError: true,
};
const SAFE_ERROR_CODES: Record<string, true> = {
  ECONNABORTED: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EHOSTDOWN: true,
  EHOSTUNREACH: true,
  EPIPE: true,
  ETIMEDOUT: true,
  EADDRINUSE: true,
  EACCES: true,
  EPERM: true,
  ENOENT: true,
  ENOSPC: true,
  EROFS: true,
  EIO: true,
  EMFILE: true,
  ENFILE: true,
  EEXIST: true,
  ENOTDIR: true,
  EISDIR: true,
  EADDRNOTAVAIL: true,
  ENETDOWN: true,
  ENETUNREACH: true,
  EAI_AGAIN: true,
  ENOTFOUND: true,
  ABORT_ERR: true,
  ERR_SQLITE_ERROR: true,
  UND_ERR_ABORTED: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_SOCKET: true,
  UND_ERR_RESPONSE_STATUS_CODE: true,
  CERT_HAS_EXPIRED: true,
  CERT_NOT_YET_VALID: true,
  DEPTH_ZERO_SELF_SIGNED_CERT: true,
  ERR_SSL_BAD_DECRYPT: true,
  ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC: true,
  ERR_SSL_WRONG_VERSION_NUMBER: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true,
  ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED: true,
  ERR_TLS_DH_PARAM_SIZE: true,
  ERR_TLS_HANDSHAKE_TIMEOUT: true,
  ERR_TLS_INVALID_PROTOCOL_VERSION: true,
  ERR_TLS_RENEGOTIATION_DISABLED: true,
  SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_GET_ISSUER_CERT: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true,
  SQLITE_ABORT: true,
  SQLITE_AUTH: true,
  SQLITE_BUSY: true,
  SQLITE_CANTOPEN: true,
  SQLITE_CONSTRAINT: true,
  SQLITE_CONSTRAINT_CHECK: true,
  SQLITE_CONSTRAINT_DATATYPE: true,
  SQLITE_CONSTRAINT_FOREIGNKEY: true,
  SQLITE_CONSTRAINT_NOTNULL: true,
  SQLITE_CONSTRAINT_PRIMARYKEY: true,
  SQLITE_CONSTRAINT_ROWID: true,
  SQLITE_CONSTRAINT_TRIGGER: true,
  SQLITE_CONSTRAINT_UNIQUE: true,
  SQLITE_CONSTRAINT_VTAB: true,
  SQLITE_CORRUPT: true,
  SQLITE_DONE: true,
  SQLITE_EMPTY: true,
  SQLITE_ERROR: true,
  SQLITE_FORMAT: true,
  SQLITE_FULL: true,
  SQLITE_INTERNAL: true,
  SQLITE_INTERRUPT: true,
  SQLITE_IOERR: true,
  SQLITE_LOCKED: true,
  SQLITE_MISMATCH: true,
  SQLITE_MISUSE: true,
  SQLITE_NOMEM: true,
  SQLITE_NOTADB: true,
  SQLITE_NOTICE: true,
  SQLITE_PERM: true,
  SQLITE_PROTOCOL: true,
  SQLITE_READONLY: true,
  SQLITE_RANGE: true,
  SQLITE_ROW: true,
  SQLITE_SCHEMA: true,
  SQLITE_TOOBIG: true,
  SQLITE_WARNING: true,
};

export class CollectionStageError extends Error {
  readonly phase: CollectionPhase;

  constructor(phase: CollectionPhase, cause: unknown) {
    super("Collection stage failed", { cause });
    this.name = "CollectionStageError";
    this.phase = phase;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}



function appendError(queue: Error[], value: unknown): void {
  if (queue.length < MAX_CAUSES && isError(value)) queue.push(value);
}

function appendAggregateErrors(queue: Error[], value: Error): void {
  let members: unknown;
  try {
    if (!(value instanceof AggregateError)) return;
    members = value.errors;
  } catch {
    return;
  }

  let errorArray: unknown[];
  try {
    if (!Array.isArray(members)) return;
    errorArray = members;
  } catch {
    return;
  }

  let length: unknown;
  try {
    length = errorArray.length;
  } catch {
    return;
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return;
  const count = Math.min(length, MAX_CAUSES - queue.length);
  for (let index = 0; index < count; index += 1) {
    let child: unknown;
    try {
      child = errorArray[index];
    } catch {
      continue;
    }
    appendError(queue, child);
  }
}

export function diagnoseCollectionError(
  error: unknown,
): CollectionErrorDiagnostic {
  const queue: Error[] = [];
  appendError(queue, error);
  const causes: CollectionErrorDiagnostic["causes"] = [];
  const seen = new Set<Error>();
  let phase: CollectionPhase = "collection";
  let hasPhase = false;

  if (queue.length === 0) causes.push({ name: "Error" });

  for (
    let index = 0;
    index < queue.length && causes.length < MAX_CAUSES;
    index += 1
  ) {
    const current = queue[index]!;
    if (seen.has(current)) continue;
    seen.add(current);

    const errorName = readProperty(current, "name");
    const name =
      typeof errorName === "string" && SAFE_ERROR_NAMES[errorName] === true
        ? errorName
        : "Error";
    const diagnostic: CollectionErrorDiagnostic["causes"][number] = { name };
    const code = readProperty(current, "code");
    if (typeof code === "string" && SAFE_ERROR_CODES[code] === true) {
      diagnostic.code = code;
    }
    const status = readProperty(current, "status");
    if (
      name === "HttpStatusError" &&
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      diagnostic.status = status;
    }
    causes.push(diagnostic);

    if (name === "CollectionStageError" && !hasPhase) {
      const candidatePhase = readProperty(current, "phase");
      if (
        typeof candidatePhase === "string" &&
        COLLECTION_PHASES[candidatePhase as CollectionPhase] === true
      ) {
        phase = candidatePhase as CollectionPhase;
        hasPhase = true;
      }
    }


    appendError(queue, readProperty(current, "cause"));
    appendAggregateErrors(queue, current);
  }

  return { phase, causes };
}
