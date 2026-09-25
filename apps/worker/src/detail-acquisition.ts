import { fetchRawDocument } from "@nju-info/collector";
import type { DiscoveredItem, RawDocument } from "@nju-info/core";

export class UnsupportedDetailAcquisitionError extends Error {
  constructor(
    readonly acquisitionKind: Exclude<DiscoveredItem["acquisitionKind"], "webplus-detail">,
    readonly sourceId: string,
    readonly url: string,
  ) {
    super(`unsupported detail acquisition for ${sourceId} (${acquisitionKind}): ${url}`);
    this.name = "UnsupportedDetailAcquisitionError";
  }
}

export async function fetchWebPlusDetail(item: DiscoveredItem): Promise<RawDocument> {
  if (item.acquisitionKind !== "webplus-detail") {
    throw new UnsupportedDetailAcquisitionError(item.acquisitionKind, item.sourceId, item.url);
  }
  return fetchRawDocument(item.sourceId, item.url);
}
