import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webPlusSourceConfigSchema, type RawDocument } from "@nju-info/core";
import { loadSourceFile } from "./registry.js";
import { discoverWebPlusPage } from "./webplus.js";

const sourcePath = new URL(
  "../../../sources/nju/undergraduate-notices.yaml",
  import.meta.url,
);
const listFixture = new URL(
  "../fixtures/webplus/undergraduate-list.html",
  import.meta.url,
);

describe("NJU Undergraduate School announcements", () => {
  it("discovers original dated links and pagination with generic WebPlus selectors", async () => {
    const source = webPlusSourceConfigSchema.parse(
      await loadSourceFile(sourcePath.pathname),
    );
    expect(source).toMatchObject({
      id: "nju-undergraduate-notices",
      name: "本科生院公告通知",
      organization: { id: "nju-undergraduate-school", name: "本科生院" },
      url: "https://jw.nju.edu.cn/ggtz/list.htm",
      adapter: { type: "webplus" },
      audience: ["undergraduate"],
      categories: ["teaching", "notice"],
      crawl: { intervalMinutes: 30 },
      enabled: true,
    });
    expect(source.adapter.selectors).toBeUndefined();

    const body = readFileSync(listFixture, "utf8");
    const raw: RawDocument = {
      sourceId: source.id,
      url: source.url,
      fetchedAt: "2026-09-24T00:00:00.000Z",
      contentType: "text/html; charset=utf-8",
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const page = discoverWebPlusPage(raw, source);

    expect(
      page.items.map(({ title, url, publishedAtRaw }) => ({
        title,
        url,
        publishedAtRaw,
      })),
    ).toEqual([
      {
        title: "2026年秋季学期公开课观摩信息（实时更新）（校内用户访问）",
        url: "https://jw.nju.edu.cn/e2/d5/c26263a844501/page.htm",
        publishedAtRaw: "2026-09-21",
      },
      {
        title: "【2026级新生】“悦读经典计划”选课通知",
        url: "https://jw.nju.edu.cn/dd/80/c26263a843136/page.htm",
        publishedAtRaw: "2026-09-07",
      },
      {
        title: "【老生】2026年秋季学期“悦读经典计划”导读班课程群信息",
        url: "https://jw.nju.edu.cn/de/30/c26263a843312/page.htm",
        publishedAtRaw: "2026-09-09",
      },
      {
        title: "2026年“南雍杯”传统诗词创作大赛征稿启事",
        url: "https://jw.nju.edu.cn/e3/d6/c26263a844758/page.htm",
        publishedAtRaw: "2026-09-23",
      },
      {
        title: "成绩更正审核结果公示（2026-09-22）",
        url: "https://jw.nju.edu.cn/e3/74/c26263a844660/page.htm",
        publishedAtRaw: "2026-09-22",
      },
      {
        title: "2026年10月14日、10月16日普通话水平测试网络报名通知及本学期测试计划安排",
        url: "https://jw.nju.edu.cn/e1/84/c26263a844164/page.htm",
        publishedAtRaw: "2026-09-17",
      },
    ]);
    expect(page).toMatchObject({
      nextPageUrl: "https://jw.nju.edu.cn/ggtz/list2.htm",
      lastPageUrl: "https://jw.nju.edu.cn/ggtz/list209.htm",
      currentPage: 1,
      totalPages: 209,
    });
  });
});
