import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  BoshanSourceConfig,
  DiscoveredItem,
  RawDocument,
} from "@nju-info/core";
import { describe, expect, it } from "vitest";
import {
  boshanPageUrl,
  discoverBoshanPage,
  parseBoshanNotice,
} from "./boshan.js";

const HOSPITAL: BoshanSourceConfig = {
  schemaVersion: 1,
  id: "nju-hospital-announcements",
  name: "南京大学医院公告通知",
  organization: {
    id: "nju-hospital",
    name: "南京大学医院",
    kind: "service-unit",
  },
  url: "https://hospital.nju.edu.cn/xwgg/ggtz/index.html",
  adapter: {
    type: "boshan",
    channelId: 18099,
    pageSize: 2,
    selectors: { content: "#zoom" },
  },
};

const ASSET: BoshanSourceConfig = {
  ...HOSPITAL,
  id: "nju-asset-management-notices",
  name: "资产管理处通知公告",
  organization: {
    id: "nju-asset-management-office",
    name: "资产管理处",
    kind: "administrative-unit",
  },
  url: "https://zcc.nju.edu.cn/sy/tzzhxx/index.html",
  adapter: {
    type: "boshan",
    channelId: 13968,
    pageSize: 2,
    selectors: { content: "#word" },
  },
};
function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/boshan/${name}`, import.meta.url),
    "utf8",
  );
}

function raw(sourceId: string, url: string, body: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-09-29T00:00:00.000Z",
    contentType: "text/html;charset=UTF-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("Boshan source adapter", () => {
  it("builds deterministic GET page URLs and discovers stable items", () => {
    const firstUrl = boshanPageUrl(HOSPITAL, 1);
    const url = new URL(firstUrl);
    expect(url.pathname).toBe("/njdx/openapi/t/info/list.do");
    expect(Buffer.from(url.searchParams.get("channelid")!, "base64").toString())
      .toBe("18099");
    expect(Buffer.from(url.searchParams.get("pageno")!, "base64").toString())
      .toBe("1");
    expect(Buffer.from(url.searchParams.get("pagesize")!, "base64").toString())
      .toBe("2");

    const page = discoverBoshanPage(
      raw(HOSPITAL.id, firstUrl, fixture("hospital-page1.json")),
      HOSPITAL,
    );
    expect(page.currentPage).toBe(1);
    expect(page.items[0]?.url).toBe(
      "https://hospital.nju.edu.cn/xwgg/ggtz/20260928/i419633.html",
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        sourceItemId: "419633",
        acquisitionKind: "boshan-detail",
        title: "关于流感疫苗集中接种的通知",
        publishedAtRaw: "2026-09-28",
      }),
      expect.objectContaining({
        sourceItemId: "419600",
        acquisitionKind: "boshan-detail",
        publishedAtRaw: "2026-09-27",
      }),
    ]);
    expect(page.nextPageUrl).toBe(boshanPageUrl(HOSPITAL, 2));
  });

  it("stops pagination on a short final page", () => {
    const page = discoverBoshanPage(
      raw(ASSET.id, boshanPageUrl(ASSET, 4), fixture("asset-final.json")),
      ASSET,
    );
    expect(page.currentPage).toBe(4);
    expect(page.items).toEqual([
      expect.objectContaining({
        sourceItemId: "401797",
        acquisitionKind: "boshan-detail",
        publishedAtRaw: "2026-07-15",
      }),
    ]);
    expect(page.nextPageUrl).toBeUndefined();
  });

  it("fails closed for an empty first page and wrong-channel records", () => {
    expect(() => discoverBoshanPage(
      raw(HOSPITAL.id, boshanPageUrl(HOSPITAL, 1), '{"infolist":[]}'),
      HOSPITAL,
    )).toThrow("empty first Boshan page");

    const wrongChannel = JSON.stringify({
      infolist: [{
        iid: 1,
        channelid: 13968,
        title: "wrong",
        releasetime: 1790568000000,
        url: "https://hospital.nju.edu.cn/x/i1.html",
      }],
    });
    expect(() => discoverBoshanPage(
      raw(HOSPITAL.id, boshanPageUrl(HOSPITAL, 1), wrongChannel),
      HOSPITAL,
    )).toThrow("Boshan channel mismatch");
  });

  it("parses Hospital detail HTML and DFS attachments", () => {
    const item: DiscoveredItem = {
      sourceId: HOSPITAL.id,
      sourceItemId: "419633",
      url: "https://hospital.nju.edu.cn/xwgg/ggtz/20260928/i419633.html",
      acquisitionKind: "boshan-detail",
      title: "list title",
      publishedAtRaw: "2026-09-28",
    };
    const detail = fixture("hospital-detail.html");
    const notice = parseBoshanNotice(
      raw(HOSPITAL.id, item.url, detail),
      HOSPITAL,
      item,
    );
    expect(notice).toMatchObject({
      sourceItemId: "419633",
      title: "关于流感疫苗集中接种的通知",
      publishedAtRaw: "2026-09-28",
      publishedOn: "2026-09-28",
      bodyText: "请按预约时间前往校医院接种。 下载附件",
    });
    expect(notice.bodyHtml).toContain(
      "https://hospital.nju.edu.cn/xwgg/ggtz/images/vaccine.png",
    );
    expect(notice.attachments).toEqual([{
      url: "https://hospital.nju.edu.cn/DFS//file/2026/09/28/flu.pdf",
      title: "接种须知",
    }]);
  });

  it("parses Asset Management content with its configured selector", () => {
    const item: DiscoveredItem = {
      sourceId: ASSET.id,
      sourceItemId: "401797",
      url: "https://zcc.nju.edu.cn/sy/tzzhxx/20260715/i401797.html",
      acquisitionKind: "boshan-detail",
      title: "list title",
      publishedAtRaw: "2026-07-15",
    };
    const detail = fixture("asset-detail.html");
    const notice = parseBoshanNotice(
      raw(ASSET.id, item.url, detail),
      ASSET,
      item,
    );
    expect(notice.title).toBe("资产管理处通知");
    expect(notice.bodyText).toContain("申请材料");
    expect(notice.attachments).toEqual([{
      url: "https://zcc.nju.edu.cn/DFS//file/2026/07/15/application.xlsx",
      title: "申请表",
    }]);
  });
});
