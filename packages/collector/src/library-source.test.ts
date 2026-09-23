import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webPlusSourceConfigSchema, type RawDocument } from "@nju-info/core";
import { loadSourceFile } from "./registry.js";
import { discoverWebPlusPage, parseWebPlusNotice } from "./webplus.js";

const sourcePath = new URL("../../../sources/nju/library-news.yaml", import.meta.url);

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/webplus/${name}`, import.meta.url),
    "utf8",
  );
}

function raw(sourceId: string, url: string, body: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-09-23T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("NJU Library news and notices source", () => {
  it("loads the registry source and discovers only listing rows plus pager URLs", async () => {
    const source = webPlusSourceConfigSchema.parse(await loadSourceFile(sourcePath.pathname));
    const page = discoverWebPlusPage(
      raw(source.id, source.url, fixture("library-list.html")),
      source,
    );

    expect(source).toMatchObject({
      id: "nju-library-news-notices",
      name: "图书馆新闻、活动与通知",
      url: "https://lib.nju.edu.cn/xw/xwtz.htm",
      adapter: { type: "webplus" },
      audience: ["all"],
      categories: ["library"],
    });
    expect(
      page.items.map(({ title, url, publishedAtRaw }) => ({
        title,
        url,
        publishedAtRaw,
      })),
    ).toEqual([
      {
        title: "【新闻】“人工智能+教育”背景下高校知识生态重塑与服务创新研讨会圆满举行",
        url: "https://lib.nju.edu.cn/info/1065/4349.htm",
        publishedAtRaw: "2026.09.22",
      },
      {
        title: "图书馆关于暑假开放时间的通知",
        url: "https://lib.nju.edu.cn/info/1065/4326.htm",
        publishedAtRaw: "2026.07.09",
      },
    ]);
    expect(page.nextPageUrl).toBe("https://lib.nju.edu.cn/xw/xwtz/34.htm");
    expect(page.lastPageUrl).toBe("https://lib.nju.edu.cn/xw/xwtz/1.htm");
  });

  it("parses a public news detail with its original URL and dotted publication date", async () => {
    const source = webPlusSourceConfigSchema.parse(await loadSourceFile(sourcePath.pathname));
    const list = discoverWebPlusPage(
      raw(source.id, source.url, fixture("library-list.html")),
      source,
    );
    const item = list.items[0];
    if (!item) throw new Error("missing library news fixture item");
    const parsed = parseWebPlusNotice(
      raw(source.id, item.url, fixture("library-news.html")),
      source,
      item,
    );

    expect(parsed).toMatchObject({
      sourceId: source.id,
      url: "https://lib.nju.edu.cn/info/1065/4349.htm",
      title: "【新闻】“人工智能+教育”背景下高校知识生态重塑与服务创新研讨会圆满举行",
      publishedAtRaw: "2026.09.22",
      publishedOn: "2026-09-22",
    });
    expect(parsed.bodyText).toContain("研讨会由江苏省高校图工委主办");
    expect(parsed.bodyHtml).toContain("class=\"v_news_content\"");
  });

  it("parses a public notice detail and retains its tabular notice content", async () => {
    const source = webPlusSourceConfigSchema.parse(await loadSourceFile(sourcePath.pathname));
    const list = discoverWebPlusPage(
      raw(source.id, source.url, fixture("library-list.html")),
      source,
    );
    const item = list.items[1];
    if (!item) throw new Error("missing library notice fixture item");
    const parsed = parseWebPlusNotice(
      raw(source.id, item.url, fixture("library-notice.html")),
      source,
      item,
    );

    expect(parsed).toMatchObject({
      sourceId: source.id,
      url: "https://lib.nju.edu.cn/info/1065/4326.htm",
      title: "图书馆关于暑假开放时间的通知",
      publishedAtRaw: "2026.07.09",
      publishedOn: "2026-07-09",
    });
    expect(parsed.bodyText).toContain("各校区分馆暑假期间");
    expect(parsed.bodyText).toContain("9:00—17:00");
    expect(parsed.bodyHtml).toContain("<table");
  });
});
