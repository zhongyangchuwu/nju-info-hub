import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { webPlusSourceConfigSchema, type RawDocument, type WebPlusSourceConfig } from "@nju-info/core";
import { loadSourceFile } from "./registry.js";
import { discoverWebPlusPage, parseWebPlusNotice } from "./webplus.js";

const sourcePath = fileURLToPath(
  new URL("../../../sources/nju/youth-league.yaml", import.meta.url),
);

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/webplus/${name}`, import.meta.url),
    "utf8",
  );
}

async function loadYouthSource(): Promise<WebPlusSourceConfig> {
  return webPlusSourceConfigSchema.parse(await loadSourceFile(sourcePath));
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

describe("NJU Youth League source", () => {
  it("loads the public source and discovers dated announcements with pagination", async () => {
    const source = await loadYouthSource();
    expect(source).toMatchObject({
      id: "nju-youth-league-announcements",
      name: "共青团南京大学委员会公告通知",
      organization: {
        id: "nju-youth-league",
        name: "共青团南京大学委员会",
      },
      url: "https://tuanwei.nju.edu.cn/ggtz/list.htm",
      audience: ["undergraduate", "graduate"],
      enabled: true,
    });

    const page = discoverWebPlusPage(
      raw(source.id, source.url, fixture("youth-list.html")),
      source,
    );

    expect(
      page.items.map(({ title, url, publishedAtRaw }) => ({
        title,
        url,
        publishedAtRaw,
      })),
    ).toEqual([
      {
        title: "共青团南京大学委员会关于陈丽敏等同志职务任免的通知",
        url: "https://tuanwei.nju.edu.cn/e3/7d/c24691a844669/page.htm",
        publishedAtRaw: "2026-09-21",
      },
      {
        title:
          "关于组织开展“立德树人扬清风 廉洁铸魂担使命”廉洁教育作品征集活动的通知",
        url: "https://tuanwei.nju.edu.cn/e2/71/c24691a844401/page.htm",
        publishedAtRaw: "2026-09-20",
      },
      {
        title: "关于公布南京大学第七期大学生骨干培训班结业及表彰名单的决定",
        url: "https://tuanwei.nju.edu.cn/e2/04/c24691a844292/page.htm",
        publishedAtRaw: "2026-09-18",
      },
    ]);
    expect(page).toMatchObject({
      nextPageUrl: "https://tuanwei.nju.edu.cn/ggtz/list2.htm",
      lastPageUrl: "https://tuanwei.nju.edu.cn/ggtz/list103.htm",
      currentPage: 1,
      totalPages: 103,
    });
  });

  it("parses a public attachment-centric announcement with little body prose", async () => {
    const source = await loadYouthSource();
    const publicUrl =
      "https://tuanwei.nju.edu.cn/e2/71/c24691a844401/page.htm";
    const finalUrl =
      "https://tuanwei.nju.edu.cn/e2/71/c24691a844401/page.psp";
    const discovered = discoverWebPlusPage(
      raw(source.id, source.url, fixture("youth-list.html")),
      source,
    ).items[1];
    expect(discovered).toBeDefined();

    const detail = raw(source.id, finalUrl, fixture("youth-attachments.html"));
    const notice = parseWebPlusNotice(detail, source, discovered);

    expect(discovered?.url).toBe(publicUrl);
    expect(notice).toMatchObject({
      sourceId: source.id,
      url: publicUrl,
      title:
        "关于组织开展“立德树人扬清风 廉洁铸魂担使命”廉洁教育作品征集活动的通知",
      publishedAtRaw: "2026-09-20",
      publishedOn: "2026-09-20",
      bodyText:
        "附件1：廉洁教育作品推荐表.docx附件2：廉洁教育作品推荐汇总表.docx附件3：廉洁教育作品信息表.docx",
    });
    expect(notice.provenance).toEqual({
      fetchedAt: detail.fetchedAt,
      contentSha256: detail.sha256,
    });
    expect(notice.sourceItemId).toBe(
      parseWebPlusNotice(
        raw(source.id, publicUrl, fixture("youth-attachments.html")),
        source,
        discovered,
      ).sourceItemId,
    );
    expect(notice.attachments).toEqual([
      {
        url: "https://tuanwei.nju.edu.cn/_upload/article/files/a1/88/b7f63ae741caac0814b42d89e8ad/ad54938a-42fd-4cc5-b550-f8b64944f633.docx",
        title: "附件1：廉洁教育作品推荐表.docx",
      },
      {
        url: "https://tuanwei.nju.edu.cn/_upload/article/files/a1/88/b7f63ae741caac0814b42d89e8ad/17893dfb-8afd-40c4-b84e-710a9e24d0c3.docx",
        title: "附件2：廉洁教育作品推荐汇总表.docx",
      },
      {
        url: "https://tuanwei.nju.edu.cn/_upload/article/files/a1/88/b7f63ae741caac0814b42d89e8ad/d52b0c59-7cc0-405e-8bc7-4f396686a00d.docx",
        title: "附件3：廉洁教育作品信息表.docx",
      },
      {
        url: "https://tuanwei.nju.edu.cn/_upload/article/files/a1/88/b7f63ae741caac0814b42d89e8ad/873a16bc-474e-42df-8198-83dac5836250.pdf",
        title:
          "【南团发2026-54】关于组织开展“立德树人扬清风 廉洁铸魂担使命”廉洁教育作品征集活动的通知.pdf",
        mediaType: "application/pdf",
      },
    ]);
  });

  it("retains an embedded PDF when the announcement has no body text", async () => {
    const source = await loadYouthSource();
    const item = discoverWebPlusPage(
      raw(source.id, source.url, fixture("youth-list.html")),
      source,
    ).items[0];
    if (!item) throw new Error("missing Youth League PDF fixture item");
    const notice = parseWebPlusNotice(
      raw(source.id, item.url, fixture("youth-pdf-only.html")),
      source,
      item,
    );

    expect(notice.url).toBe(item.url);
    expect(notice.title).toBe(item.title);
    expect(notice.publishedOn).toBe("2026-09-21");
    expect(notice.bodyText).toBe("");
    expect(notice.attachments).toEqual([
      {
        url: "https://tuanwei.nju.edu.cn/_upload/article/files/f1/51/5cf2c9534b4d9cc011ca5b033d97/5817e1c8-6881-4517-999e-b833be5fca2a.pdf",
        title: "【南团发2026-57】共青团南京大学委员会关于陈丽敏等同志.pdf",
        mediaType: "application/pdf",
      },
    ]);
  });
});
