import { describe, expect, it, vi } from "vitest";
import { fetchRawDocument, sourceDetailUrl } from "@nju-info/collector";
import {
  sourceItemIdFromUrl,
  type DiscoveredItem,
  type RawDocument,
  type SourceConfig,
} from "@nju-info/core";
import {
  UnsupportedDetailAcquisitionError,
  fetchSourceDetail,
} from "./detail-acquisition.js";

vi.mock("@nju-info/collector", () => ({
  fetchRawDocument: vi.fn(),
  sourceDetailUrl: vi.fn(),
}));

const fetchDetail = vi.mocked(fetchRawDocument);
const resolveDetailUrl = vi.mocked(sourceDetailUrl);
const sourceId = "nju-student-affairs-notices";
const WEBPLUS_SOURCE: SourceConfig = {
  schemaVersion: 1,
  id: sourceId,
  name: "Student Affairs notices",
  organization: { id: "nju-student-affairs", name: "党委学生工作部" },
  url: "https://xgb.nju.edu.cn/gsgg/list.htm",
  adapter: { type: "webplus" },
};

const JOB_SOURCE: SourceConfig = {
  schemaVersion: 1,
  id: "nju-employment-news",
  name: "学生就业指导中心新闻动态",
  organization: {
    id: "nju-career-center",
    name: "南京大学学生就业指导中心",
    kind: "service-unit",
  },
  url: "https://job.nju.edu.cn/career/info?type=NEWS",
  adapter: {
    type: "job-portal-information",
    contentType: "NEWS",
    pageSize: 15,
  },
};

function item(
  source: SourceConfig,
  url: string,
  acquisitionKind: DiscoveredItem["acquisitionKind"],
): DiscoveredItem {
  return {
    sourceId: source.id,
    sourceItemId: sourceItemIdFromUrl(url),
    url,
    acquisitionKind,
    title: "Official list item",
  };
}
describe("worker detail acquisition", () => {
  it.each([
    ["public-wechat", "https://mp.weixin.qq.com/s/article"],
    ["external-public", "https://outside.example/news"],
  ] as const)("rejects %s before requesting detail", async (kind, url) => {
    fetchDetail.mockClear();
    resolveDetailUrl.mockClear();

    await expect(
      fetchSourceDetail(WEBPLUS_SOURCE, item(WEBPLUS_SOURCE, url, kind)),
    ).rejects.toMatchObject({
      name: "UnsupportedDetailAcquisitionError",
      acquisitionKind: kind,
      sourceId,
      url,
    } satisfies Partial<UnsupportedDetailAcquisitionError>);
    expect(fetchDetail).not.toHaveBeenCalled();
    expect(resolveDetailUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["webplus-detail", "https://grawww.nju.edu.cn/d8/32/c905a841778/page.htm"],
    ["boshan-detail", "https://hospital.nju.edu.cn/xwgg/ggtz/20260928/i419633.html"],
  ] as const)("requests supported %s detail without changing its response", async (kind, url) => {
    fetchDetail.mockClear();
    resolveDetailUrl.mockReset();
    resolveDetailUrl.mockReturnValueOnce(url);
    const raw: RawDocument = {
      sourceId,
      url,
      fetchedAt: "2026-09-25T00:00:00Z",
      contentType: "text/html",
      body: "<html></html>",
      sha256: "test-hash",
    };
    fetchDetail.mockResolvedValueOnce(raw);

    await expect(
      fetchSourceDetail(WEBPLUS_SOURCE, item(WEBPLUS_SOURCE, url, kind)),
    ).resolves.toBe(raw);
    expect(resolveDetailUrl).toHaveBeenCalledExactlyOnceWith(
      WEBPLUS_SOURCE,
      expect.objectContaining({ acquisitionKind: kind, url }),
    );
    expect(fetchDetail).toHaveBeenCalledExactlyOnceWith(sourceId, url);
  });

  it("uses the source adapter detail URL for employment information", async () => {
    fetchDetail.mockClear();
    resolveDetailUrl.mockReset();
    const publicUrl =
      "https://job.nju.edu.cn/career/info/627558707399495681?type=NEWS";
    const apiUrl =
      "https://job.nju.edu.cn/api/career/content/informations/627558707399495681";
    resolveDetailUrl.mockReturnValueOnce(apiUrl);
    const raw: RawDocument = {
      sourceId: JOB_SOURCE.id,
      url: apiUrl,
      fetchedAt: "2026-09-29T00:00:00Z",
      contentType: "application/json",
      body: "{}",
      sha256: "test-hash",
    };
    fetchDetail.mockResolvedValueOnce(raw);
    const discovered: DiscoveredItem = {
      sourceId: JOB_SOURCE.id,
      sourceItemId: "627558707399495681",
      url: publicUrl,
      acquisitionKind: "job-portal-information",
      title: "Employment notice",
    };

    await expect(fetchSourceDetail(JOB_SOURCE, discovered)).resolves.toBe(raw);
    expect(resolveDetailUrl).toHaveBeenCalledExactlyOnceWith(
      JOB_SOURCE,
      discovered,
    );
    expect(fetchDetail).toHaveBeenCalledExactlyOnceWith(
      JOB_SOURCE.id,
      apiUrl,
    );
  });
});
