import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  DiscoveredItem,
  JobPortalInformationSourceConfig,
  RawDocument,
} from "@nju-info/core";
import { describe, expect, it } from "vitest";
import {
  discoverJobPortalInformationPage,
  jobPortalInformationDetailUrl,
  jobPortalInformationPageUrl,
  parseJobPortalInformationNotice,
} from "./job-portal-information.js";

const NEWS: JobPortalInformationSourceConfig = {
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
    pageSize: 2,
  },
};
const GUIDE: JobPortalInformationSourceConfig = {
  ...NEWS,
  id: "nju-employment-guidance",
  name: "学生就业指导中心就业指导",
  url: "https://job.nju.edu.cn/career/info?type=GUIDE",
  adapter: {
    type: "job-portal-information",
    contentType: "GUIDE",
    pageSize: 2,
  },
};

function fixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/job-portal/${name}`, import.meta.url),
    "utf8",
  );
}

function raw(sourceId: string, url: string, body: string): RawDocument {
  return {
    sourceId,
    url,
    fetchedAt: "2026-09-29T11:00:00.000Z",
    contentType: "application/json",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

describe("job portal information source adapter", () => {
  it("builds deterministic API page URLs and discovers public item URLs", () => {
    const firstUrl = jobPortalInformationPageUrl(NEWS, 1);
    const url = new URL(firstUrl);
    expect(url.pathname).toBe("/api/career/content/informations");
    expect(url.searchParams.get("page")).toBe("0");
    expect(url.searchParams.get("size")).toBe("2");
    expect(url.searchParams.get("type")).toBe("NEWS");

    const page = discoverJobPortalInformationPage(
      raw(NEWS.id, firstUrl, fixture("news-page1.json")),
      NEWS,
    );
    expect(page.currentPage).toBe(1);
    expect(page.totalPages).toBe(2);
    expect(page.nextPageUrl).toBe(jobPortalInformationPageUrl(NEWS, 2));
    expect(page.items).toEqual([
      expect.objectContaining({
        sourceItemId: "627558707399495681",
        url:
          "https://job.nju.edu.cn/career/info/627558707399495681?type=NEWS",
        acquisitionKind: "job-portal-information",
        publishedAtRaw: "2026-09-28",
      }),
      expect.objectContaining({
        sourceItemId: "627520720619966465",
        url:
          "https://www.91job.org.cn/recruitment/meetingDetail?zphid=81042",
        acquisitionKind: "external-public",
        publishedAtRaw: "2026-09-27",
      }),
    ]);
  });

  it("stops at the final page and rejects mismatched source records", () => {
    const finalUrl = jobPortalInformationPageUrl(GUIDE, 2);
    const page = discoverJobPortalInformationPage(
      raw(GUIDE.id, finalUrl, fixture("guide-final.json")),
      GUIDE,
    );
    expect(page.currentPage).toBe(2);
    expect(page.nextPageUrl).toBeUndefined();
    expect(page.items[0]).toMatchObject({
      sourceItemId: "guide-1",
      acquisitionKind: "job-portal-information",
      publishedAtRaw: "2026-09-16",
    });

    const wrongType = fixture("news-page1.json").replace(
      '"type": "NEWS"',
      '"type": "GUIDE"',
    );
    expect(() =>
      discoverJobPortalInformationPage(
        raw(NEWS.id, jobPortalInformationPageUrl(NEWS, 1), wrongType),
        NEWS,
      ),
    ).toThrow("job portal type mismatch");
  });
  it("fails closed for login-only and duplicate list records", () => {
    const loginRequired = fixture("news-page1.json").replace(
      '"loginRequired": false',
      '"loginRequired": true',
    );
    expect(() =>
      discoverJobPortalInformationPage(
        raw(
          NEWS.id,
          jobPortalInformationPageUrl(NEWS, 1),
          loginRequired,
        ),
        NEWS,
      ),
    ).toThrow("job portal item requires login");

    const parsed = JSON.parse(fixture("news-page1.json")) as {
      content: Array<Record<string, unknown>>;
      page: Record<string, unknown>;
    };
    parsed.content[1]!.id = parsed.content[0]!.id;
    expect(() =>
      discoverJobPortalInformationPage(
        raw(
          NEWS.id,
          jobPortalInformationPageUrl(NEWS, 1),
          JSON.stringify(parsed),
        ),
        NEWS,
      ),
    ).toThrow("duplicate job portal id");
  });
  it("separates the API detail URL from the human-facing item URL", () => {
    expect(
      jobPortalInformationDetailUrl(NEWS, "627558707399495681"),
    ).toBe(
      "https://job.nju.edu.cn/api/career/content/informations/627558707399495681",
    );
  });

  it("parses JSON detail content, media links, and attachments", () => {
    const item: DiscoveredItem = {
      sourceId: NEWS.id,
      sourceItemId: "627558707399495681",
      url:
        "https://job.nju.edu.cn/career/info/627558707399495681?type=NEWS",
      acquisitionKind: "job-portal-information",
      title: "list title",
      publishedAtRaw: "2026-09-28",
    };
    const detail = fixture("news-detail.json");
    const notice = parseJobPortalInformationNotice(
      raw(
        NEWS.id,
        jobPortalInformationDetailUrl(NEWS, item.sourceItemId),
        detail,
      ),
      NEWS,
      item,
    );
    expect(notice).toMatchObject({
      sourceItemId: item.sourceItemId,
      url: item.url,
      title: "南京大学秋季招聘双选会邀请函",
      publishedAtRaw: "2026-09-28",
      publishedOn: "2026-09-28",
    });
    expect(notice.bodyText).toContain("欢迎用人单位参加");
    expect(notice.bodyHtml).toContain(
      'src="https://job.nju.edu.cn/images/fair.png"',
    );
    expect(notice.bodyHtml).toContain(
      'href="https://job.nju.edu.cn/career/help"',
    );
    expect(notice.attachments).toEqual([
      {
        url: "https://jobfile.nju.edu.cn/job3/notice.pdf",
        title: "notice.pdf",
      },
      {
        url:
          "https://jobfile.nju.edu.cn/job3/%E8%A1%A8%E6%A0%BC.xlsx",
        title: "表格.xlsx",
      },
    ]);
    expect(notice.provenance.contentSha256).toBe(
      createHash("sha256").update(detail).digest("hex"),
    );
  });
});
