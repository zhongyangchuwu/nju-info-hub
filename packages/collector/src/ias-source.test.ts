import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RawDocument } from "@nju-info/core";
import { webPlusSourceConfigSchema } from "@nju-info/core";
import { loadSourceFile } from "./registry.js";
import { discoverWebPlusPage, parseWebPlusNotice } from "./webplus.js";

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
    fetchedAt: "2026-10-10T00:00:00.000Z",
    contentType: "text/html; charset=utf-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("IAS WebPlus sources", () => {
  it("discovers only lecture table rows and preserves full detail title and event data", async () => {
    const config = webPlusSourceConfigSchema.parse(await loadSourceFile(
      new URL("../../../sources/nju/ias-lectures.yaml", import.meta.url).pathname,
    ));
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("ias-lectures-list.html")),
      config,
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sourceId: config.id,
      url: "https://ias.nju.edu.cn/be/6b/c13159a835179/page.htm",
      title:
        "上海科技大学人文科学研究院徐芃副教授演讲“诗歌作为媒介：徐媛的‘自由’与晚明诗歌的一种可能” 2026.6.2...",
      publishedAtRaw: "2026-06-09",
      acquisitionKind: "webplus-detail",
    });
    expect(page.items.some(({ url }) => url.includes("c13160a836093"))).toBe(false);
    expect(page.nextPageUrl).toBe("https://ias.nju.edu.cn/13159/list2.htm");
    expect(page.lastPageUrl).toBe("https://ias.nju.edu.cn/13159/list25.htm");
    expect(page.currentPage).toBe(1);
    expect(page.totalPages).toBe(25);

    const discovered = page.items[0]!;
    const notice = parseWebPlusNotice(
      raw(config.id, discovered.url, fixture("ias-lecture-detail.html")),
      config,
      discovered,
    );

    expect(notice).toMatchObject({
      title:
        "上海科技大学人文科学研究院徐芃副教授演讲“诗歌作为媒介：徐媛的‘自由’与晚明诗歌的一种可能” 2026.6.22",
      publishedAtRaw: "2026-06-09",
      publishedOn: "2026-06-09",
    });
    expect(notice.bodyText).toContain("2026年6月22日（周一）下午15：00");
    expect(notice.bodyText).toContain(
      "南京大学仙林校区邵逸夫楼马克思主义学院C308",
    );
    expect(notice.bodyHtml).toContain(
      'src="https://ias.nju.edu.cn/_upload/article/images/1a/74/dda76df64150b18891843421dae0/d4be6826-e477-48fe-bcc9-11352248af80.png"',
    );
  });

  it("keeps the mixed IAS activities category separate from news and preserves its schedule", async () => {
    const config = webPlusSourceConfigSchema.parse(await loadSourceFile(
      new URL("../../../sources/nju/ias-activities.yaml", import.meta.url).pathname,
    ));
    const page = discoverWebPlusPage(
      raw(config.id, config.url, fixture("ias-activities-list.html")),
      config,
    );

    expect(page.items.map(({ url, title, publishedAtRaw }) => ({
      url,
      title,
      publishedAtRaw,
    }))).toEqual([
      {
        url: "https://ias.nju.edu.cn/dc/f4/c13161a842996/page.htm",
        title: "艺术与人工智能人文学国际学术工作坊系列（2026—2027）",
        publishedAtRaw: "2026-09-04",
      },
      {
        url: "https://ias.nju.edu.cn/af/84/c13161a831364/page.htm",
        title: "南京大学高研院2026年（下半年）短期驻院学者（校内短驻）招聘启事",
        publishedAtRaw: "2026-04-29",
      },
    ]);
    expect(page.items.some(({ url }) => url.includes("c13160a836093"))).toBe(false);
    expect(page.nextPageUrl).toBe("https://ias.nju.edu.cn/13161/list2.htm");
    expect(page.lastPageUrl).toBe("https://ias.nju.edu.cn/13161/list9.htm");
    expect(page.currentPage).toBe(1);
    expect(page.totalPages).toBe(9);

    const discovered = page.items[0]!;
    const notice = parseWebPlusNotice(
      raw(config.id, discovered.url, fixture("ias-activity-detail.html")),
      config,
      discovered,
    );

    expect(notice).toMatchObject({
      title: "艺术与人工智能人文学国际学术工作坊系列（2026—2027）",
      publishedAtRaw: "2026-09-04",
      publishedOn: "2026-09-04",
    });
    expect(notice.bodyText).toContain("2026年10月19日：Tiziana Andina");
    expect(notice.bodyText).toContain("2027年4月—5月：Yuk Hui");
    expect(notice.bodyText).toContain("线上或线下工作坊，60分钟主旨发言+对话讨论");
  });
});
