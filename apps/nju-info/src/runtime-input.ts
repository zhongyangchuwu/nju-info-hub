type RuntimeInputCode =
  | "unknown_command"
  | "invalid_image_ref"
  | "invalid_ready_timeout"
  | "usage_validate"
  | "usage_collect"
  | "usage_status"
  | "usage_export"
  | "usage_schedule"
  | "usage_backup"
  | "usage_restore"
  | "usage_verify_backup"
  | "unknown_source"
  | "unknown_source_command"
  | "usage_source"
  | "usage_source_ingest"
  | "invalid_limit";

const GUIDANCE: Record<RuntimeInputCode, string> = {
  unknown_command: "usage: nju-info <serve|validate|collect|schedule|status|export|backup|restore|verify-backup|source> [args...]",
  invalid_image_ref: "official GHCR image must use an immutable sha-* tag, version tag, or sha256 digest",
  invalid_ready_timeout: "NJU_INFO_READY_TIMEOUT_SECONDS must be a non-negative integer",
  usage_validate: "usage: nju-info validate [config.json] [source-dir]",
  usage_collect: "usage: nju-info collect [config.json] [source-dir] [database]",
  usage_status: "usage: nju-info status [database]",
  usage_export: "usage: nju-info export [config.json] [source-dir] [database] [output-dir]",
  usage_schedule: "usage: nju-info schedule [config.json] [source-dir] [database]",
  usage_backup: "usage: nju-info backup <snapshot.tar.gz> [database]",
  usage_restore: "usage: nju-info restore <snapshot.tar.gz> [database]",
  usage_verify_backup: "usage: nju-info verify-backup <snapshot.tar.gz>",
  unknown_source: "Use nju-info source sources to list registered source IDs",
  unknown_source_command: "Use nju-info source <sources|discover|discover-pages|fetch|ingest>",
  usage_source: "usage: nju-info source <discover|discover-pages|fetch|ingest> <source-id> [args...]",
  usage_source_ingest: "usage: nju-info source ingest <source-id> <database-path> [limit]",
  invalid_limit: "Source limits and page counts must be positive integers",
};

export class RuntimeInputError extends Error {
  constructor(readonly code: RuntimeInputCode) {
    super("Invalid runtime input");
  }
}

/** Only this module's finite codes can contribute user-facing guidance. */
export function runtimeInputDiagnostic(error: unknown): { code: RuntimeInputCode; hint: string } | undefined {
  try {
    if (!(error instanceof RuntimeInputError)) return undefined;
    const code = error.code;
    if (typeof code !== "string" || !Object.hasOwn(GUIDANCE, code)) return undefined;
    return { code, hint: GUIDANCE[code] };
  } catch {
    return undefined;
  }
}
