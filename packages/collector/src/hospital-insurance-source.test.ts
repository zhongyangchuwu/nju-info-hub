import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RawDocument } from "@nju-info/core";
import { boshanSourceConfigSchema } from "@nju-info/core";
import { describe, expect, it } from "vitest";
import {
  boshanPageUrl,
  discoverBoshanPage,
  parseBoshanNotice,
} from "./boshan.js";
import { loadSourceFile } from "./registry.js";

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
    fetchedAt: "2026-10-10T00:00:00.000Z",
    contentType: "text/html;charset=UTF-8",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("hospital student-insurance source", () => {
  it("uses the publication day, not the detail URL/list display day", async () => {
    const SOURCE = boshanSourceConfigSchema.parse(await loadSourceFile(
      new URL("../../../sources/nju/hospital-student-insurance.yaml", import.meta.url).pathname,
    ));
    // Reduced public API fixture retaining the observed releasetime/daytime conflict.
    const page = discoverBoshanPage(
      raw(
        SOURCE.id,
        boshanPageUrl(SOURCE, 1),
        fixture("hospital-insurance-date-boundary-list.reduced.json"),
      ),
      SOURCE,
    );
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item).toMatchObject({
      sourceId: SOURCE.id,
      sourceItemId: "397421",
      url: "https://hospital.nju.edu.cn/gfyyb/dxsyb/20260617/i397421.html",
      acquisitionKind: "boshan-detail",
      publishedAtRaw: "2026-03-17",
    });

    // Reduced from the linked public detail; binary images and page chrome are omitted.
    const notice = parseBoshanNotice(
      raw(
        SOURCE.id,
        item.url,
        fixture("hospital-insurance-date-boundary-detail.reduced.html"),
      ),
      SOURCE,
      item,
    );
    expect(notice).toMatchObject({
      sourceId: SOURCE.id,
      sourceItemId: "397421",
      url: item.url,
      title: "【通知】关于2025年度大学生医疗费用零星报销相关工作的通知",
      publishedAtRaw: "2026-03-17",
      publishedOn: "2026-03-17",
    });
    expect(notice.bodyText).toContain("请于2026年3月31日之前提交报销材料");
    expect(notice.bodyText).toContain("鼓楼校医院 421室");
    expect(notice.bodyText).toContain("苏州校区门诊部");
    expect(notice.bodyHtml).toContain(
      "https://hospital.nju.edu.cn/DFS//file/2026/06/17/20260617164912520xx74qp.png",
    );
  });
});
