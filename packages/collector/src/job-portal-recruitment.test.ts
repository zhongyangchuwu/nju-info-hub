import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  DiscoveredItem,
  JobPortalRecruitmentSourceConfig,
  RawDocument,
} from "@nju-info/core";
import { describe, expect, it } from "vitest";
import {
  discoverJobPortalRecruitmentPage,
  jobPortalRecruitmentDetailUrl,
  jobPortalRecruitmentPageUrl,
  parseJobPortalRecruitmentNotice,
} from "./job-portal-recruitment.js";

const SOURCE: JobPortalRecruitmentSourceConfig = {
  schemaVersion: 1,
  id: "nju-employment-recruitments",
  name: "学生就业指导中心招聘信息",
  organization: {
    id: "nju-career-center",
    name: "南京大学学生就业指导中心",
    kind: "service-unit",
  },
  url: "https://job.nju.edu.cn/career/jobs-v2",
  adapter: {
    type: "job-portal-recruitment",
    pageSize: 2,
  },
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/job-portal-recruitment/${name}`, import.meta.url),
    "utf8",
  );
}
function raw(url: string, body: string): RawDocument {
  return {
    sourceId: SOURCE.id,
    url,
    fetchedAt: "2026-09-29T12:00:00.000Z",
    contentType: "application/json",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("job portal recruitment adapter", () => {
  it("discovers recruitment batches with stable human-facing URLs", () => {
    const firstUrl = jobPortalRecruitmentPageUrl(SOURCE, 1);
    const page = discoverJobPortalRecruitmentPage(
      raw(firstUrl, fixture("page1.json")),
      SOURCE,
    );

    expect(new URL(firstUrl).pathname).toBe("/api/career/job/recruitments");
    expect(page.currentPage).toBe(1);
    expect(page.totalPages).toBe(2);
    expect(page.nextPageUrl).toBe(jobPortalRecruitmentPageUrl(SOURCE, 2));
    expect(page.items).toEqual([
      expect.objectContaining({
        sourceItemId: "620320974528581633",
        url:
          "https://job.nju.edu.cn/career/jobs-v2?recruitmentId=620320974528581633",
        acquisitionKind: "job-portal-recruitment",
        title: "苏州晶银新材料科技有限公司2026校园招聘",
        publishedAtRaw: "2026-09-28",
      }),
      expect.objectContaining({
        sourceItemId: "625257785524752386",
        acquisitionKind: "job-portal-recruitment",
        publishedAtRaw: "2026-09-22",
      }),
    ]);
  });
  it("stops at the final page and fails closed on visibility mismatches", () => {
    const finalUrl = jobPortalRecruitmentPageUrl(SOURCE, 2);
    const page = discoverJobPortalRecruitmentPage(
      raw(finalUrl, fixture("final.json")),
      SOURCE,
    );
    expect(page.currentPage).toBe(2);
    expect(page.nextPageUrl).toBeUndefined();

    const disabled = fixture("page1.json").replace(
      '"enabled": true',
      '"enabled": false',
    );
    expect(() =>
      discoverJobPortalRecruitmentPage(
        raw(jobPortalRecruitmentPageUrl(SOURCE, 1), disabled),
        SOURCE,
      ),
    ).toThrow("unexpected recruitment visibility");

    const parsed = JSON.parse(fixture("page1.json")) as {
      content: Array<Record<string, unknown>>;
      page: Record<string, unknown>;
    };
    parsed.content[1]!.id = parsed.content[0]!.id;
    expect(() =>
      discoverJobPortalRecruitmentPage(
        raw(
          jobPortalRecruitmentPageUrl(SOURCE, 1),
          JSON.stringify(parsed),
        ),
        SOURCE,
      ),
    ).toThrow("duplicate recruitment id");
  });
  it("separates API detail provenance from the jobs-v2 public URL", () => {
    expect(
      jobPortalRecruitmentDetailUrl(SOURCE, "620320974528581633"),
    ).toBe(
      "https://job.nju.edu.cn/api/career/job/recruitments/620320974528581633",
    );
  });

  it("normalizes intro links and appends structured position details", () => {
    const item: DiscoveredItem = {
      sourceId: SOURCE.id,
      sourceItemId: "620320974528581633",
      url:
        "https://job.nju.edu.cn/career/jobs-v2?recruitmentId=620320974528581633",
      acquisitionKind: "job-portal-recruitment",
      title: "list title",
      publishedAtRaw: "2026-09-28",
    };
    const detail = fixture("detail.json");
    const notice = parseJobPortalRecruitmentNotice(
      raw(jobPortalRecruitmentDetailUrl(SOURCE, item.sourceItemId), detail),
      SOURCE,
      item,
    );

    expect(notice).toMatchObject({
      sourceItemId: item.sourceItemId,
      url: item.url,
      title: "苏州晶银新材料科技有限公司2026校园招聘",
      publishedAtRaw: "2026-09-28",
      publishedOn: "2026-09-28",
      attachments: [],
    });
    expect(notice.bodyText).toContain("苏州晶银新材料科技有限公司");
    expect(notice.bodyText).toContain("研发工程师");
    expect(notice.bodyText).toContain("硕士及以上学历");
    expect(notice.bodyHtml).toContain(
      'src="https://job.nju.edu.cn/images/recruit.png"',
    );
    expect(notice.bodyHtml).toContain(
      'href="https://job.nju.edu.cn/career/help"',
    );
    expect(notice.bodyHtml).toContain("江苏省 / 苏州市 / 虎丘区");
    expect(notice.provenance.contentSha256).toBe(
      createHash("sha256").update(detail).digest("hex"),
    );
  });

  it("still produces useful content when intro and positions are absent", () => {
    const body = JSON.stringify({
      id: "minimal-1",
      company: { name: "测试单位" },
      theme: "测试招聘",
      deadline: "2026-10-01",
      enabled: true,
      applyAt: "2026-09-29 08:00:00",
      status: "PUBLISHED",
      positions: [],
    });
    const item: DiscoveredItem = {
      sourceId: SOURCE.id,
      sourceItemId: "minimal-1",
      url: "https://job.nju.edu.cn/career/jobs-v2?recruitmentId=minimal-1",
      acquisitionKind: "job-portal-recruitment",
      title: "测试招聘",
    };
    const notice = parseJobPortalRecruitmentNotice(
      raw(jobPortalRecruitmentDetailUrl(SOURCE, item.sourceItemId), body),
      SOURCE,
      item,
    );
    expect(notice.bodyText).toContain("测试单位");
    expect(notice.bodyText).toContain("2026-10-01");
  });
});
