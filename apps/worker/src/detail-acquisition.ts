import { fetchRawDocument } from "@nju-info/collector";
import type { DiscoveredItem, RawDocument } from "@nju-info/core";

type SupportedDetailAcquisitionKind = "webplus-detail" | "boshan-detail";

export class UnsupportedDetailAcquisitionError extends Error {
  constructor(
    readonly acquisitionKind: Exclude<
      DiscoveredItem["acquisitionKind"],
      SupportedDetailAcquisitionKind
    >,
    readonly sourceId: string,
    readonly url: string,
  ) {
    super(`unsupported detail acquisition for ${sourceId} (${acquisitionKind}): ${url}`);
    this.name = "UnsupportedDetailAcquisitionError";
  }
}

export async function fetchSourceDetail(item: DiscoveredItem): Promise<RawDocument> {
  if (
    item.acquisitionKind !== "webplus-detail" &&
    item.acquisitionKind !== "boshan-detail"
  ) {
    throw new UnsupportedDetailAcquisitionError(item.acquisitionKind, item.sourceId, item.url);
  }
  return fetchRawDocument(item.sourceId, item.url);
}

export const fetchWebPlusDetail = fetchSourceDetail;
