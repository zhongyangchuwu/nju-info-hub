import { createHash } from "node:crypto";

/** Preserve the WebPlus source-scoped item key used by existing notice revisions. */
export function sourceItemIdFromUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}
