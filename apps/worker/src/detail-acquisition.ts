import { fetchRawDocument } from "@nju-info/collector";
import type { DiscoveredItem, RawDocument } from "@nju-info/core";

export async function fetchWebPlusDetail(item: DiscoveredItem): Promise<RawDocument> {
  if (item.acquisitionKind !== "webplus-detail") {
    throw new Error(
      `unsupported detail acquisition for ${item.sourceId} (${item.acquisitionKind}): ${item.url}`,
    );
  }
  return fetchRawDocument(item.sourceId, item.url);
}
