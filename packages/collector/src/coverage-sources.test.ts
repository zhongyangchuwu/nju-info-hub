import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawDocument, WebPlusSourceConfig } from "@nju-info/core";
import { describe, expect, it } from "vitest";
import { loadSourceFile } from "./registry.js";
import { discoverWebPlusPage } from "./webplus.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/webplus/${name}`, import.meta.url),
    "utf8",
  );
}

async function source(name: string): Promise<WebPlusSourceConfig> {
  return await loadSourceFile(fileURLToPath(
    new URL(`../../../sources/nju/${name}`, import.meta.url),
  ));
}

function raw(sourceId: string, url: string, body: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-09-29T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("M2A source coverage configs", () => {
  it("discovers Security Office WebPlus notices with default selectors", async () => {
    const config = await source("security-office.yaml");
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("security-list.html")),
      config,
    );

    expect(config.organization.kind).toBe("administrative-unit");
    expect(page.items.map(({ title, acquisitionKind, publishedAtRaw }) => ({
      title,
      acquisitionKind,
      publishedAtRaw,
    }))).toEqual([
      {
        title: "南京大学火灾自动报警与联动系统测试二期鼓楼校区21栋火灾自动报警与联动系统改造工程中标公告",
        acquisitionKind: "webplus-detail",
        publishedAtRaw: "2026-09-17",
      },
      {
        title: "南京大学火灾自动报警与联动系统测试二期鼓楼校区 21 栋火灾自动报警与联动系统改造工程",
        acquisitionKind: "webplus-detail",
        publishedAtRaw: "2026-09-10",
      },
    ]);
    expect(page).toMatchObject({
      nextPageUrl: "https://bwc.nju.edu.cn/64525/list2.htm",
      lastPageUrl: "https://bwc.nju.edu.cn/64525/list30.htm",
      currentPage: 1,
      totalPages: 30,
    });
  });

  it("retains Psychology Center public-WeChat and WebPlus rows", async () => {
    const config = await source("psychology-center.yaml");
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("psychology-list.html")),
      config,
    );

    expect(config.adapter.selectors?.listItem).toBe(".news_list li.news");
    expect(page.items.map(({ url, acquisitionKind, publishedAtRaw }) => ({
      url,
      acquisitionKind,
      publishedAtRaw,
    }))).toEqual([
      {
        url: "https://mp.weixin.qq.com/s/2gFbD322yNpuVVQKzLn6sw",
        acquisitionKind: "public-wechat",
        publishedAtRaw: "2026-09-09",
      },
      {
        url: "https://njuxlzx.nju.edu.cn/ce/4a/c47935a839242/page.htm",
        acquisitionKind: "webplus-detail",
        publishedAtRaw: "2026-07-14",
      },
    ]);
  });

  it("retains Logistics local details and external public rows", async () => {
    const config = await source("logistics.yaml");
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("logistics-list.html")),
      config,
    );

    expect(config.adapter.selectors?.listItem).toBe(".news_list li.news");
    expect(page.items.map(({ url, acquisitionKind, publishedAtRaw }) => ({
      url,
      acquisitionKind,
      publishedAtRaw,
    }))).toEqual([
      {
        url: "https://hqjt.nju.edu.cn/d1/17/c1214a839959/page.htm",
        acquisitionKind: "webplus-detail",
        publishedAtRaw: "2026-07-21",
      },
      {
        url: "https://zcc.nju.edu.cn/sy/tzzhxx/20260715/i401797.html",
        acquisitionKind: "external-public",
        publishedAtRaw: "2026-07-15",
      },
    ]);
  });
});
