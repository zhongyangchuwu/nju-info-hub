import { describe, expect, it, vi } from "vitest";
import { fetchRawDocument } from "@nju-info/collector";
import { sourceItemIdFromUrl, type DiscoveredItem, type RawDocument } from "@nju-info/core";
import { UnsupportedDetailAcquisitionError, fetchSourceDetail } from "./detail-acquisition.js";

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

    await expect(fetchSourceDetail(item(url, kind))).rejects.toMatchObject({
      name: "UnsupportedDetailAcquisitionError",
      acquisitionKind: kind,
      sourceId,
      url,
    } satisfies Partial<UnsupportedDetailAcquisitionError>);
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it.each([
    ["webplus-detail", "https://grawww.nju.edu.cn/d8/32/c905a841778/page.htm"],
    ["boshan-detail", "https://hospital.nju.edu.cn/xwgg/ggtz/20260928/i419633.html"],
  ] as const)("requests supported %s detail without changing its response", async (kind, url) => {
    fetchDetail.mockClear();
    const raw: RawDocument = {
      sourceId,
      url,
      fetchedAt: "2026-09-25T00:00:00Z",
      contentType: "text/html",
      body: "<html></html>",
      sha256: "test-hash",
    };
    fetchDetail.mockResolvedValueOnce(raw);

    await expect(fetchSourceDetail(item(url, kind))).resolves.toBe(raw);
    expect(fetchDetail).toHaveBeenCalledExactlyOnceWith(sourceId, url);
  });
});
