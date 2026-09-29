import { fetchRawDocument, sourceDetailUrl } from "@nju-info/collector";
import type {
  DiscoveredItem,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";

type SupportedDetailAcquisitionKind =
  | "webplus-detail"
  | "boshan-detail"
  | "job-portal-information"
  | "job-portal-recruitment";

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

export async function fetchSourceDetail(
  source: SourceConfig,
  item: DiscoveredItem,
): Promise<RawDocument> {
  if (
    item.acquisitionKind !== "webplus-detail" &&
    item.acquisitionKind !== "boshan-detail" &&
    item.acquisitionKind !== "job-portal-information" &&
    item.acquisitionKind !== "job-portal-recruitment"
  ) {
    throw new UnsupportedDetailAcquisitionError(item.acquisitionKind, item.sourceId, item.url);
  }
  return fetchRawDocument(item.sourceId, sourceDetailUrl(source, item));
}

export async function fetchWebPlusDetail(item: DiscoveredItem): Promise<RawDocument> {
  return fetchRawDocument(item.sourceId, item.url);
}
