import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RawDocument, WebPlusSourceConfig } from "@nju-info/core";
import { webPlusSourceConfigSchema } from "@nju-info/core";
import {
  RestrictedDetailError,
  discoverWebPlusItems,
  discoverWebPlusPage,
  orderDiscoveredItemsByPublicationRecency,
  parseWebPlusNotice,
} from "./webplus.js";
import { loadSourceFile } from "./registry.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/webplus/${name}`, import.meta.url),
    "utf8",
  );
}

function source(
  id: string,
  name: string,
  url: string,
  organization = "南京大学",
): WebPlusSourceConfig {
  return {
    schemaVersion: 1,
    id,
    name,
    organization: { id: `${id}-org`, name: organization },
    url,
    adapter: { type: "webplus" },
    audience: ["graduate"],
    categories: ["notice"],
    enabled: true,
  };
}

function raw(sourceId: string, url: string, body: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-09-22T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("WebPlus adapter", () => {
  it("discovers CS notices and WebPlus pagination links", () => {
    const config = source(
      "nju-cs-graduate",
      "计算机学院研究生公告栏",
      "https://cs.nju.edu.cn/1703/list.htm",
      "计算机学院",
    );
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("cs-list.html")),
      config,
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      title: "计算机学院2026年研究生奖学金评选工作的通知",
      publishedAtRaw: "2026-09-21",
    });
    expect(page.nextPageUrl).toBe("https://cs.nju.edu.cn/1703/list2.htm");
    expect(page.lastPageUrl).toBe("https://cs.nju.edu.cn/1703/list29.htm");
    expect(page.currentPage).toBe(1);
    expect(page.totalPages).toBe(29);
  });

  it("discovers Graduate School split dates in source order", () => {
    const config = source(
      "nju-graduate-school-notices",
      "研究生院动态通知",
      "https://grawww.nju.edu.cn/905/list.htm",
      "研究生院",
    );
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("graduate-list.html")),
      config,
    );

    expect(
      page.items.map(({ title, publishedAtRaw }) => ({
        title,
        publishedAtRaw,
      })),
    ).toEqual([
      {
        title: "鼓楼校区综合服务大厅值班表",
        publishedAtRaw: "08-20 2026",
      },
      {
        title: "关于2027春季学期研究生赴台交流项目校内推荐名单的公示",
        publishedAtRaw: "09-21 2026",
      },
      {
        title: "关于2027春季学期研究生赴台交流项目遴选答辩的通知",
        publishedAtRaw: "09-18 2026",
      },
    ]);
    expect(page.nextPageUrl).toBe("https://grawww.nju.edu.cn/905/list2.htm");
    expect(page.lastPageUrl).toBe("https://grawww.nju.edu.cn/905/list56.htm");
  });

  it("orders pinned dated items by recency without changing discovery order", () => {
    const config = source(
      "nju-graduate-school-notices",
      "研究生院动态通知",
      "https://grawww.nju.edu.cn/905/list.htm",
    );
    const sourceOrdered = discoverWebPlusItems(
      raw(config.id, config.url, fixture("graduate-list.html")),
      config,
    );

    expect(sourceOrdered.map(({ publishedAtRaw }) => publishedAtRaw)).toEqual([
      "08-20 2026",
      "09-21 2026",
      "09-18 2026",
    ]);
    expect(
      orderDiscoveredItemsByPublicationRecency(sourceOrdered).map(
        ({ publishedAtRaw }) => publishedAtRaw,
      ),
    ).toEqual(["09-21 2026", "09-18 2026", "08-20 2026"]);
  });

  it("keeps missing and unparseable dates in deterministic source order", () => {
    const items = [
      {
        sourceId: "test",
        sourceItemId: "6ea736f94d6f826876eea7dd",
        url: "https://example.edu/old",
        acquisitionKind: "webplus-detail" as const,
        title: "old",
        publishedAtRaw: "2026-01-01",
      },
      {
        sourceId: "test",
        sourceItemId: "b96fa87947fd01be7c6e5983",
        url: "https://example.edu/missing",
        acquisitionKind: "webplus-detail" as const,
        title: "missing",
      },
      {
        sourceId: "test",
        sourceItemId: "ccbdae6d5063a50e63c4e68a",
        url: "https://example.edu/new",
        acquisitionKind: "webplus-detail" as const,
        title: "new",
        publishedAtRaw: "2026-09-01",
      },
      {
        sourceId: "test",
        sourceItemId: "283a17ccc2273243f248d0b4",
        url: "https://example.edu/invalid",
        acquisitionKind: "webplus-detail" as const,
        title: "invalid",
        publishedAtRaw: "unknown",
      },
    ];

    expect(
      orderDiscoveredItemsByPublicationRecency(items).map(({ title }) => title),
    ).toEqual(["new", "old", "missing", "invalid"]);
  });

  it.each([
    [
      "xgb-list.html",
      "nju-student-affairs-notices",
      "https://xgb.nju.edu.cn/gsgg/list.htm",
      "关于开展2026年度南京大学研究生奖学金评选工作的通知",
      2,
    ],
    [
      "stuex-list.html",
      "nju-student-exchange",
      "https://stuex.nju.edu.cn/2539/list.htm",
      "【奥地利-本科生】2027年春季学期格拉茨大学Erasmus+交换项目通知",
      1,
    ],
  ])("parses list structure from %s", (file, id, url, title, count) => {
    const config = source(id, id, url);
    const items = discoverWebPlusItems(raw(id, url, fixture(file)), config);

    expect(items).toHaveLength(count);
    expect(items[0]?.title).toBe(title);
    expect(items.every((item) => item.acquisitionKind === "webplus-detail")).toBe(true);
  });

  it("preserves Student Affairs official list items across acquisition classes", async () => {
    const config = webPlusSourceConfigSchema.parse(
      await loadSourceFile(
        new URL("../../../sources/nju/student-affairs.yaml", import.meta.url).pathname,
      ),
    );
    const items = discoverWebPlusItems(
      raw(config.id, config.url, fixture("xgb-list.html")),
      config,
    );

    expect(items).toEqual([
      {
        sourceId: config.id,
        sourceItemId: "3a146e473126e78d445b4a61",
        url: "https://xgb.nju.edu.cn/e2/b3/c62106a844467/page.htm",
        title: "关于开展2026年度南京大学研究生奖学金评选工作的通知",
        publishedAtRaw: "2026-09-20",
        acquisitionKind: "webplus-detail",
      },
      {
        sourceId: config.id,
        sourceItemId: "c7ab0f32a602f827efad2024",
        url: "https://grawww.nju.edu.cn/d8/32/c905a841778/page.htm",
        title: "南京大学2026级研究生新生入学报到日程安排",
        publishedAtRaw: "2026-08-28",
        acquisitionKind: "webplus-detail",
      },
      {
        sourceId: config.id,
        sourceItemId: "80b6b99cbb580b12fb8a1f94",
        url: "https://mp.weixin.qq.com/s/thJbuquZGdmdHDoeIe-fOg",
        title: "@NJUer！“白海豚”来了，这份防台指南请收好",
        publishedAtRaw: "2026-08-08",
        acquisitionKind: "public-wechat",
      },
    ]);
  });

  it("keeps default discovery from following arbitrary external navigation", () => {
    const config = source("nju-test", "Test", "https://test.nju.edu.cn/list.htm");
    const items = discoverWebPlusItems(
      raw(config.id, config.url, `
        <ul class="news_list">
          <li><a href="/a/page.htm">Official article</a></li>
          <li><a href="https://mp.weixin.qq.com/s/article">WeChat navigation</a></li>
          <li><a href="https://outside.example/news">External navigation</a></li>
        </ul>`),
      config,
    );

    expect(items.map(({ url, acquisitionKind }) => ({ url, acquisitionKind }))).toEqual([
      { url: "https://test.nju.edu.cn/a/page.htm", acquisitionKind: "webplus-detail" },
    ]);
  });

  it("classifies explicitly listed non-WebPlus HTTP links without trusting host lookalikes", () => {
    const config = source("nju-test", "Test", "https://test.nju.edu.cn/list.htm");
    config.adapter.selectors = { listItem: ".news_list li.news" };
    const items = discoverWebPlusItems(
      raw(config.id, config.url, `
        <ul class="news_list">
          <li class="news"><a href="https://outside.example/news">External public</a></li>
          <li class="news"><a href="https://mp.weixin.qq.com.evil.example/s/article">Impostor</a></li>
          <li class="news"><a href="https://mp.weixin.qq.com/s">WeChat short path</a></li>
        </ul>`),
      config,
    );

    expect(items.map(({ acquisitionKind }) => acquisitionKind)).toEqual([
      "external-public",
      "external-public",
      "public-wechat",
    ]);
  });

  it("parses content and both link/pdf-player attachments", () => {
    const config = source(
      "nju-cs-graduate",
      "计算机学院研究生公告栏",
      "https://cs.nju.edu.cn/1703/list.htm",
      "计算机学院",
    );
    const detailUrl = "https://cs.nju.edu.cn/e2/e4/c1703a844516/page.htm";
    const detail = raw(config.id, detailUrl, fixture("cs-detail.html"));

    const notice = parseWebPlusNotice(detail, config);
    expect(notice.title).toContain("研究生奖学金");
    expect(notice.publishedAtRaw).toBe("2026-09-21");
    expect(notice.publishedOn).toBe("2026-09-21");
    expect(notice.bodyText).toContain("请按要求提交材料");
    expect(notice.attachments).toHaveLength(2);
    expect(notice.attachments.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        "https://cs.nju.edu.cn/_upload/article/files/a/notice.pdf",
        "https://cs.nju.edu.cn/_upload/article/files/a/form.xlsx",
      ]),
    );
  });

  it("rejects campus IP warning pages before configured content extraction", () => {
    const config: WebPlusSourceConfig = {
      ...source("nju-campus-restricted", "Campus source", "https://notice.nju.edu.cn/list.htm"),
      adapter: { type: "webplus", selectors: { content: ".wp_articlecontent" } },
    };
    const detail = raw(
      config.id,
      "https://notice.nju.edu.cn/a/page.htm",
      fixture("campus-restricted.html"),
    );

    try {
      parseWebPlusNotice(detail, config);
      throw new Error("expected campus restriction to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RestrictedDetailError);
      expect((error as RestrictedDetailError).restrictionClass).toBe("campus-network");
    }
  });

  it("classifies only deterministic NJU unified identity redirects", () => {
    const config = source("nju-test-notices", "Test", "https://example.edu/list.htm");
    const discovered = {
      sourceId: config.id,
      sourceItemId: "f3521068de7e7718c1245bc0",
      url: "https://example.edu/a/page.htm",
      acquisitionKind: "webplus-detail" as const,
      title: "Known notice",
      publishedAtRaw: "2026-09-21",
    };
    const originalDiscovery = { ...discovered };
    const redirected = raw(
      config.id,
      "https://authserver.nju.edu.cn/authserver/login?service=https%3A%2F%2Fexample.edu",
      "<html><title>统一身份认证</title></html>",
    );

    try {
      parseWebPlusNotice(redirected, config, discovered);
      throw new Error("expected unified identity redirect to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RestrictedDetailError);
      expect((error as RestrictedDetailError).restrictionClass).toBe("authentication");
    }
    expect(discovered).toEqual(originalDiscovery);

    const unrelatedRedirect = raw(
      config.id,
      "https://login.example.net/authserver/login",
      '<h1 class="arti_title">Known notice</h1><div class="wp_articlecontent">Body</div>',
    );
    expect(parseWebPlusNotice(unrelatedRedirect, config, discovered).title).toBe(
      "Known notice",
    );
  });

  it("keeps malformed missing-content pages as ordinary errors", () => {
    const config = source("nju-test-notices", "Test", "https://example.edu/list.htm");
    let error: unknown;
    try {
      parseWebPlusNotice(
        raw(config.id, "https://example.edu/a/page.htm", '<h1>Notice</h1>'),
        config,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RestrictedDetailError);
    expect((error as Error).message).toBe(
      "missing notice content for nju-test-notices: https://example.edu/a/page.htm",
    );
  });

  it("uses a split list date when detail metadata is absent", () => {
    const config = source(
      "nju-graduate-school-notices",
      "研究生院动态通知",
      "https://grawww.nju.edu.cn/905/list.htm",
    );
    const discovered = discoverWebPlusItems(
      raw(config.id, config.url, fixture("graduate-list.html")),
      config,
    )[1];
    expect(discovered).toBeDefined();
    const detail = raw(
      config.id,
      discovered!.url,
      '<h1 class="arti_title">Notice</h1><div class="wp_articlecontent">Body</div>',
    );
    const notice = parseWebPlusNotice(detail, config, discovered);
    expect(notice.publishedAtRaw).toBe("09-21 2026");
    expect(notice.publishedOn).toBe("2026-09-21");
  });

  it("keeps invalid publication dates as unparseable", () => {
    const config = source("nju-test-notices", "Test", "https://example.edu/list.htm");
    const detail = raw(
      config.id,
      "https://example.edu/a/page.htm",
      '<h1 class="arti_title">Notice</h1><div class="arti_update">2026-02-29</div><div class="wp_articlecontent">Body</div>',
    );
    const notice = parseWebPlusNotice(detail, config);
    expect(notice.publishedAtRaw).toBe("2026-02-29");
    expect(notice.publishedOn).toBeNull();
  });

  it("ignores upload links outside the article content", () => {
    const config = source(
      "nju-cs-graduate",
      "计算机学院研究生公告栏",
      "https://cs.nju.edu.cn/1703/list.htm",
      "计算机学院",
    );
    const detail = raw(
      config.id,
      "https://cs.nju.edu.cn/a/b/c1a1/page.htm",
      `<a href="/_upload/article/files/a/sidebar.pdf">sidebar</a>
       <h1 class="arti_title">Notice</h1>
       <div class="wp_articlecontent">
         <a href="/_upload/article/files/a/body.pdf">body</a>
       </div>`,
    );

    const notice = parseWebPlusNotice(detail, config);
    expect(notice.attachments).toEqual([
      expect.objectContaining({
        url: "https://cs.nju.edu.cn/_upload/article/files/a/body.pdf",
      }),
    ]);
  });

  it("ignores cross-origin pagination links", () => {
    const config = source(
      "nju-test",
      "Test",
      "https://example.nju.edu.cn/notices/list.htm",
    );
    const page = discoverWebPlusPage(
      raw(
        config.id,
        config.url,
        '<div class="wp_paging"><a class="next" href="https://evil.example/list2.htm">next</a></div>',
      ),
      config,
    );

    expect(page.nextPageUrl).toBeUndefined();
  });

  it("uses a configured listItem selector for links and nearby dates", () => {
    const config: WebPlusSourceConfig = {
      ...source(
        "nju-custom",
        "Custom",
        "https://custom.nju.edu.cn/notices/list.htm",
      ),
      adapter: {
        type: "webplus",
        selectors: { listItem: ".notice-card" },
      },
    };
    const page = discoverWebPlusPage(
      raw(
        config.id,
        config.url,
        '<div class="notice-card"><a href="/a/b/c1a1/page.htm">Custom notice</a><time>2026-09-22</time></div>',
      ),
      config,
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        title: "Custom notice",
        publishedAtRaw: "2026-09-22",
      }),
    ]);
  });
});
