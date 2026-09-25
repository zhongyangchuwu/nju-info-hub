import { describe, expect, it, vi } from "vitest";
import { fetchRawDocument } from "@nju-info/collector";
import { sourceItemIdFromUrl, type DiscoveredItem, type RawDocument } from "@nju-info/core";
import { UnsupportedDetailAcquisitionError, fetchWebPlusDetail } from "./detail-acquisition.js";

vi.mock("@nju-info/collector", () => ({ fetchRawDocument: vi.fn() }));

const fetchDetail = vi.mocked(fetchRawDocument);
const sourceId = "nju-student-affairs-notices";

function item(url: string, acquisitionKind: DiscoveredItem["acquisitionKind"]): DiscoveredItem {
  return { sourceId, sourceItemId: sourceItemIdFromUrl(url), url, acquisitionKind, title: "Official list item" };
}

describe("worker detail acquisition", () => {
  it.each([
    ["public-wechat", "https://mp.weixin.qq.com/s/article"],
    ["external-public", "https://outside.example/news"],
  ] as const)("rejects %s before requesting detail", async (kind, url) => {
    fetchDetail.mockClear();

    await expect(fetchWebPlusDetail(item(url, kind))).rejects.toMatchObject({
      name: "UnsupportedDetailAcquisitionError",
      acquisitionKind: kind,
      sourceId,
      url,
    } satisfies Partial<UnsupportedDetailAcquisitionError>);
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it("requests ordinary WebPlus detail without changing its response", async () => {
    fetchDetail.mockClear();
    const url = "https://grawww.nju.edu.cn/d8/32/c905a841778/page.htm";
    const raw: RawDocument = {
      sourceId,
      url,
      fetchedAt: "2026-09-25T00:00:00Z",
      contentType: "text/html",
      body: "<html></html>",
      sha256: "test-hash",
    };
    fetchDetail.mockResolvedValueOnce(raw);

    await expect(fetchWebPlusDetail(item(url, "webplus-detail"))).resolves.toBe(raw);
    expect(fetchDetail).toHaveBeenCalledExactlyOnceWith(sourceId, url);
  });
});
