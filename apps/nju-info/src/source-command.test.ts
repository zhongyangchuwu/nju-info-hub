import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSourceCommand } from "./source-command.js";
import { CollectionStageError, diagnoseCollectionError } from "@nju-info/worker/diagnostics";

const sourceUrl = "https://stuex.nju.edu.cn/2539/list.htm";
const baseUrl = "https://stuex.nju.edu.cn";
const hospitalApiUrl =
  "https://hospital.nju.edu.cn/njdx/openapi/t/info/list.do?channelid=MTgwOTk%3D&pageno=MQ%3D%3D&pagesize=MTU%3D";
const detail = (name: string) => `${baseUrl}/${name}/page.htm`;
const restriction = readFileSync(
  new URL("../../../packages/collector/fixtures/webplus/campus-restricted.html", import.meta.url),
  "utf8",
);
const originalExitCode = process.exitCode;
const sourceDirectory = fileURLToPath(new URL("../../../sources/nju/", import.meta.url));

function list(
  items: { name: string; date: string }[],
  nextPage?: string,
): string {
  return `<ul class="news_list">${items
    .map(
      ({ name, date }) =>
        `<li><a href="/${name}/page.htm">${name}</a><span>${date}</span></li>`,
    )
    .join("")}</ul>${nextPage ? `<div class="wp_paging"><a class="next" href="${nextPage}">Next</a></div>` : ""}`;
}

function publicDetail(name: string): string {
  return `<h1 class="arti_title">${name}</h1><div class="wp_articlecontent">Public ${name}</div>`;
}

function mockPages(pages: Record<string, { body: string; finalUrl?: string }>) {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requested.push(input);
      const page = pages[input];
      if (!page) throw new Error(`unexpected GET ${input}`);
      const response = new Response(page.body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "url", { value: page.finalUrl ?? input });
      return response;
    }),
  );
  return requested;
}

async function runSource(sourceId: string, command: string, ...args: string[]) {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  let failure: unknown;
  try {
    await runSourceCommand([command, sourceId, ...args], sourceDirectory);
  } catch (error) {
    failure = error;
    process.exitCode = 1;
  }
  return {
    output: stdout.mock.calls.map(([value]) => String(value)).join("\n"),
    failure,
  };
}

function run(command: string, ...args: string[]) {
  return runSource("nju-student-exchange", command, ...args);
}

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("worker restricted details", () => {
  it("keeps the newest restricted item in the recent window without refilling from older items", async () => {
    const requested = mockPages({
      [sourceUrl]: {
        body: list(
          [
            { name: "blocked", date: "2026-09-24" },
            { name: "public-old", date: "2026-09-20" },
          ],
          "/2539/list2.htm",
        ),
      },
      [`${baseUrl}/2539/list2.htm`]: {
        body: list([{ name: "public-new", date: "2026-09-23" }], "/2539/list3.htm"),
      },
      [detail("blocked")]: { body: restriction },
      [detail("public-new")]: { body: publicDetail("public-new") },
    });

    const result = await run("fetch", "2");
    expect(JSON.parse(result.output).map((notice: { title: string }) => notice.title)).toEqual([
      "public-new",
    ]);
    expect(requested).toEqual([
      sourceUrl,
      `${baseUrl}/2539/list2.htm`,
      detail("blocked"),
      detail("public-new"),
    ]);
  });

  it("observes every lookahead row while enriching only the recent candidates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-lookahead-worker-"));
    const path = join(directory, "notices.sqlite");
    try {
      const secondListUrl = `${baseUrl}/2539/list2.htm`;
      const requested = mockPages({
        [sourceUrl]: {
          body: list([
            { name: "older", date: "2026-09-20" },
            { name: "newer", date: "2026-09-24" },
          ], "/2539/list2.htm"),
        },
        [secondListUrl]: {
          body: list([
            { name: "lookahead-newest", date: "2026-09-25" },
            { name: "lookahead-extra", date: "2026-09-23" },
          ]),
        },
        [detail("newer")]: { body: publicDetail("newer") },
        [detail("lookahead-newest")]: { body: publicDetail("lookahead-newest") },
      });

      const result = await run("ingest", path, "2");
      expect(JSON.parse(result.output)).toMatchObject({
        pagesVisited: 2,
        itemsObserved: 4,
        noticesIngested: 2,
        stats: { sourceItems: 4, sourceItemObservations: 4, noticeRevisions: 2 },
      });
      expect(requested).toEqual([
        sourceUrl, secondListUrl, detail("lookahead-newest"), detail("newer"),
      ]);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare(`
          SELECT source_items.url, raw_documents.final_url AS list_url
          FROM source_item_observations
          JOIN source_items ON source_items.id = source_item_observations.source_item_row_id
          JOIN raw_documents ON raw_documents.id = source_item_observations.raw_document_id
          ORDER BY source_items.url
        `).all()).toEqual([
          { url: detail("lookahead-extra"), list_url: secondListUrl },
          { url: detail("lookahead-newest"), list_url: secondListUrl },
          { url: detail("newer"), list_url: sourceUrl },
          { url: detail("older"), list_url: sourceUrl },
        ]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not refill from older pages when the newest source items are restricted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-restricted-worker-"));
    const path = join(directory, "notices.sqlite");
    try {
      const secondListUrl = `${baseUrl}/2539/list2.htm`;
      const requested = mockPages({
        [sourceUrl]: {
          body: list(
            [
              { name: "ip-blocked", date: "2026-09-24" },
              { name: "auth-blocked", date: "2026-09-23" },
            ],
            "/2539/list2.htm",
          ),
        },
        [secondListUrl]: {
          body: list([{ name: "ip-blocked-two", date: "2026-09-22" }], "/2539/list3.htm"),
        },
        [detail("ip-blocked")]: { body: restriction },
        [detail("auth-blocked")]: {
          body: "<html>Sign in</html>",
          finalUrl: "https://authserver.nju.edu.cn/authserver/login?service=test",
        },
      });

      const result = await run("ingest", path, "2");
      const summary = JSON.parse(result.output);
      expect(summary).toMatchObject({
        pagesVisited: 2,
        itemsObserved: 3,
        noticesIngested: 0,
        insertedRevisions: 0,
      });
      expect(requested).toEqual([
        sourceUrl,
        secondListUrl,
        detail("ip-blocked"),
        detail("auth-blocked"),
      ]);

      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT url FROM source_items ORDER BY url").all()).toEqual([
          { url: detail("auth-blocked") },
          { url: detail("ip-blocked-two") },
          { url: detail("ip-blocked") },
        ]);
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get())
          .toEqual({ count: 3 });
        expect(database.prepare("SELECT count(*) AS count FROM notice_revisions").get())
          .toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not swallow ordinary missing-content failures", async () => {
    mockPages({
      [sourceUrl]: { body: list([{ name: "broken", date: "2026-09-24" }]) },
      [detail("broken")]: { body: "<h1>Broken article</h1>" },
    });
    const result = await run("fetch", "1");
    expect(result.output).toBe("");
    expect(result.failure).toBeInstanceOf(CollectionStageError);
    expect(diagnoseCollectionError(result.failure).phase).toBe("detail-parse");
    expect(process.exitCode).toBe(1);
  });

  it("keeps list discovery metadata for restricted links", async () => {
    mockPages({
      [sourceUrl]: { body: list([{ name: "blocked", date: "2026-09-24" }]) },
    });
    const result = await run("discover", "1");
    expect(JSON.parse(result.output)).toEqual([
      expect.objectContaining({
        url: detail("blocked"),
        acquisitionKind: "webplus-detail",
        publishedAtRaw: "2026-09-24",
      }),
    ]);
  });

  it("keeps public-WeChat link-only items inside the recent window without refilling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-mixed-worker-"));
    const path = join(directory, "notices.sqlite");
    const listUrl = "https://xgb.nju.edu.cn/gsgg/list.htm";
    const wechatUrl = "https://mp.weixin.qq.com/s/public-article";
    const first = "https://xgb.nju.edu.cn/a/page.htm";
    const second = "https://xgb.nju.edu.cn/b/page.htm";
    try {
      const requested = mockPages({
        [listUrl]: {
          body: `<ul class="news_list">
            <li class="news"><a href="${wechatUrl}">Public WeChat</a><span>2026-09-24</span></li>
            <li class="news"><a href="${first}">First public</a><span>2026-09-23</span></li>
            <li class="news"><a href="${second}">Second public</a><span>2026-09-22</span></li>
          </ul>`,
        },
        [first]: { body: publicDetail("First public") },
      });
      const result = await runSource("nju-student-affairs-notices", "ingest", path, "2");
      expect(JSON.parse(result.output)).toMatchObject({
        itemsObserved: 3,
        noticesIngested: 1,
        insertedRevisions: 1,
      });
      expect(requested).toEqual([listUrl, first]);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT url FROM source_items ORDER BY url").all()).toEqual([
          { url: wechatUrl },
          { url: first },
          { url: second },
        ]);
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get())
          .toEqual({ count: 3 });
        expect(database.prepare("SELECT count(*) AS count FROM notice_revisions").get())
          .toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("collects every unseen item beyond the refresh limit until the known-history boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-incremental-worker-"));
    const path = join(directory, "notices.sqlite");
    const secondListUrl = `${baseUrl}/2539/list2.htm`;
    const thirdListUrl = `${baseUrl}/2539/list3.htm`;
    try {
      mockPages({
        [sourceUrl]: {
          body: list([
            { name: "known-newer", date: "2026-09-20" },
            { name: "known-older", date: "2026-09-19" },
          ]),
        },
        [detail("known-newer")]: { body: publicDetail("known-newer") },
        [detail("known-older")]: { body: publicDetail("known-older") },
      });
      const bootstrap = await run("ingest", path, "2");
      expect(JSON.parse(bootstrap.output)).toMatchObject({
        itemsObserved: 2,
        noticesIngested: 2,
        insertedRevisions: 2,
      });
      vi.restoreAllMocks();

      const requested = mockPages({
        [sourceUrl]: {
          body: list([
            { name: "new-one", date: "2026-09-25" },
            { name: "new-two", date: "2026-09-24" },
            { name: "new-three", date: "2026-09-23" },
          ], "/2539/list2.htm"),
        },
        [secondListUrl]: {
          body: list([
            { name: "known-newer", date: "2026-09-20" },
            { name: "known-older", date: "2026-09-19" },
          ], "/2539/list3.htm"),
        },
        [thirdListUrl]: {
          body: list([{ name: "lookahead-new", date: "2026-09-18" }], "/2539/list4.htm"),
        },
        [detail("new-one")]: { body: publicDetail("new-one") },
        [detail("new-two")]: { body: publicDetail("new-two") },
        [detail("new-three")]: { body: publicDetail("new-three") },
        [detail("known-newer")]: { body: publicDetail("known-newer") },
        [detail("known-older")]: { body: publicDetail("known-older") },
      });
      const incremental = await run("ingest", path, "2");
      expect(JSON.parse(incremental.output)).toMatchObject({
        pagesVisited: 3,
        itemsObserved: 6,
        noticesIngested: 5,
        insertedRevisions: 3,
        unchangedRevisions: 2,
        stats: { sourceItems: 6, noticeRevisions: 5 },
      });
      expect(requested).toEqual([
        sourceUrl,
        secondListUrl,
        thirdListUrl,
        detail("new-one"),
        detail("new-two"),
        detail("new-three"),
        detail("known-newer"),
        detail("known-older"),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops legacy sparse history after mixed overlap and one older lookahead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-sparse-frontier-"));
    const path = join(directory, "notices.sqlite");
    const second = `${baseUrl}/2539/list2.htm`;
    const third = `${baseUrl}/2539/list3.htm`;
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "known", date: "2026-09-20" }]) },
        [detail("known")]: { body: publicDetail("known") },
      });
      await run("ingest", path, "1");
      vi.restoreAllMocks();

      const requested = mockPages({
        [sourceUrl]: { body: list([{ name: "new", date: "2026-09-27" }], "/2539/list2.htm") },
        [second]: { body: list([
          { name: "known", date: "2026-09-20" },
          { name: "legacy-unknown", date: "2026-09-19" },
        ], "/2539/list3.htm") },
        [third]: { body: list([{ name: "lookahead-old", date: "2026-09-18" }], "/2539/list4.htm") },
        [detail("new")]: { body: publicDetail("new") },
        [detail("legacy-unknown")]: { body: publicDetail("legacy-unknown") },
        [detail("known")]: { body: publicDetail("known") },
      });
      const result = await run("ingest", path, "1");
      expect(JSON.parse(result.output)).toMatchObject({
        pagesVisited: 3,
        itemsObserved: 4,
        noticesIngested: 3,
        insertedRevisions: 2,
        unchangedRevisions: 1,
      });
      expect(requested).toEqual([
        sourceUrl, second, third,
        detail("new"), detail("known"), detail("legacy-unknown"),
      ]);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get())
          .toEqual({ count: 4 });
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("collects burst updates across fully-unseen pages before overlap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-burst-frontier-"));
    const path = join(directory, "notices.sqlite");
    const second = `${baseUrl}/2539/list2.htm`;
    const third = `${baseUrl}/2539/list3.htm`;
    const fourth = `${baseUrl}/2539/list4.htm`;
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "known", date: "2026-09-20" }]) },
        [detail("known")]: { body: publicDetail("known") },
      });
      await run("ingest", path, "1");
      vi.restoreAllMocks();

      const requested = mockPages({
        [sourceUrl]: { body: list([{ name: "burst-one", date: "2026-09-27" }], "/2539/list2.htm") },
        [second]: { body: list([{ name: "burst-two", date: "2026-09-26" }], "/2539/list3.htm") },
        [third]: { body: list([{ name: "known", date: "2026-09-20" }], "/2539/list4.htm") },
        [fourth]: { body: list([{ name: "lookahead", date: "2026-09-19" }], "/2539/list5.htm") },
        [detail("burst-one")]: { body: publicDetail("burst-one") },
        [detail("burst-two")]: { body: publicDetail("burst-two") },
        [detail("known")]: { body: publicDetail("known") },
      });
      const result = await run("ingest", path, "1");
      expect(JSON.parse(result.output)).toMatchObject({
        pagesVisited: 4, itemsObserved: 4, noticesIngested: 3,
        insertedRevisions: 2, unchangedRevisions: 1,
      });
      expect(requested).toEqual([
        sourceUrl, second, third, fourth,
        detail("burst-one"), detail("burst-two"), detail("known"),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scans one lookahead page when overlap is already on page one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-normal-frontier-"));
    const path = join(directory, "notices.sqlite");
    const second = `${baseUrl}/2539/list2.htm`;
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "known", date: "2026-09-20" }]) },
        [detail("known")]: { body: publicDetail("known") },
      });
      await run("ingest", path, "1");
      vi.restoreAllMocks();

      const requested = mockPages({
        [sourceUrl]: { body: list([
          { name: "new", date: "2026-09-27" },
          { name: "known", date: "2026-09-20" },
        ], "/2539/list2.htm") },
        [second]: { body: list([{ name: "lookahead", date: "2026-09-19" }], "/2539/list3.htm") },
        [detail("new")]: { body: publicDetail("new") },
        [detail("known")]: { body: publicDetail("known") },
      });
      const result = await run("ingest", path, "1");
      expect(JSON.parse(result.output)).toMatchObject({
        pagesVisited: 2, itemsObserved: 3, noticesIngested: 2,
        insertedRevisions: 1, unchangedRevisions: 1,
      });
      expect(requested).toEqual([
        sourceUrl, second, detail("new"), detail("known"),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails without observing or enriching when no overlap is found in ten pages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-capped-frontier-"));
    const path = join(directory, "notices.sqlite");
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "known", date: "2026-09-20" }]) },
        [detail("known")]: { body: publicDetail("known") },
      });
      await run("ingest", path, "1");
      vi.restoreAllMocks();

      const urls = [sourceUrl, ...Array.from({ length: 10 }, (_, index) =>
        `${baseUrl}/2539/list${index + 2}.htm`)];
      const requested = mockPages(Object.fromEntries(urls.map((url, index) => [url, {
        body: list([{ name: `historical-${index}`, date: "2026-09-19" }],
          `/2539/list${index + 2}.htm`),
      }])));
      const result = await run("ingest", path, "1");
      expect(result.output).toBe("");
      expect(result.failure).toBeInstanceOf(CollectionStageError);
      expect(diagnoseCollectionError(result.failure).phase).toBe("discovery");
      expect(process.exitCode).toBe(1);
      expect(requested).toEqual(urls.slice(0, 10));
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get())
          .toEqual({ count: 1 });
        expect(database.prepare("SELECT count(*) AS count FROM notice_revisions").get())
          .toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows lookahead beyond the tenth-page overlap search", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-overlap-limit-"));
    const path = join(directory, "notices.sqlite");
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "known", date: "2026-09-20" }]) },
        [detail("known")]: { body: publicDetail("known") },
      });
      await run("ingest", path, "1");
      vi.restoreAllMocks();

      const urls = [sourceUrl, ...Array.from({ length: 10 }, (_, index) =>
        `${baseUrl}/2539/list${index + 2}.htm`)];
      const pages = Object.fromEntries(urls.map((url, index) => [url, {
        body: list([{ name: index === 9 ? "known" : `item-${index}`, date: "2026-09-20" }],
          `/2539/list${index + 2}.htm`),
      }]));
      const details = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        detail(`item-${index}`), { body: publicDetail(`item-${index}`) },
      ]));
      details[detail("known")] = { body: publicDetail("known") };
      const requested = mockPages({ ...pages, ...details });
      const result = await run("ingest", path, "1");
      expect(JSON.parse(result.output)).toMatchObject({
        pagesVisited: 11, itemsObserved: 11, noticesIngested: 10,
        insertedRevisions: 9, unchangedRevisions: 1,
      });
      expect(requested.slice(0, 11)).toEqual(urls);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists the candidate observation before malformed detail parsing aborts ingest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-malformed-worker-"));
    const path = join(directory, "notices.sqlite");
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "broken", date: "2026-09-24" }]) },
        [detail("broken")]: { body: "<h1>Broken article</h1>" },
      });
      const result = await run("ingest", path, "1");
      expect(result.failure).toBeInstanceOf(CollectionStageError);
      expect(process.exitCode).toBe(1);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get()).toEqual({ count: 1 });
        expect(
          database.prepare(`
            SELECT raw_documents.final_url
            FROM source_item_observations
            JOIN raw_documents ON raw_documents.id = source_item_observations.raw_document_id
          `).get(),
        ).toEqual({ final_url: sourceUrl });
        expect(database.prepare("SELECT count(*) AS count FROM notice_revisions").get()).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("routes Boshan discovery through its public list API", async () => {
    const requested = mockPages({
      [hospitalApiUrl]: {
        body: JSON.stringify({
          pages: 1,
          infolist: [{
            iid: 419633,
            channelid: 18099,
            title: "Hospital notice",
            releasetime: 1790208392000,
            url: "http://hospital.nju.edu.cn//xwgg/ggtz/20260928/i419633.html",
          }],
        }),
      },
    });
    const result = await runSource("nju-hospital-announcements", "discover", "1");
    expect(JSON.parse(result.output)).toEqual([
      expect.objectContaining({
        sourceItemId: "419633",
        url: "https://hospital.nju.edu.cn/xwgg/ggtz/20260928/i419633.html",
        acquisitionKind: "boshan-detail",
        publishedAtRaw: "2026-09-24",
      }),
    ]);
    expect(requested).toEqual([hospitalApiUrl]);
  });

  it("keeps mixed acquisition kinds and list order without fetching details", async () => {
    const listUrl = "https://xgb.nju.edu.cn/gsgg/list.htm";
    const wechatUrl = "https://mp.weixin.qq.com/s/public-article";
    const externalUrl = "https://outside.example/news";
    const restrictedUrl = "https://xgb.nju.edu.cn/restricted/page.htm";
    const requested = mockPages({
      [listUrl]: {
        body: `<ul class="news_list">
          <li class="news"><a href="${restrictedUrl}">Restricted</a><span>2026-09-24</span></li>
          <li class="news"><a href="${wechatUrl}">Public WeChat</a><span>2026-09-23</span></li>
          <li class="news"><a href="${externalUrl}">External</a><span>2026-09-22</span></li>
        </ul>`,
      },
    });
    const result = await runSource("nju-student-affairs-notices", "discover-pages", "2");
    expect(JSON.parse(result.output).items).toEqual([
      expect.objectContaining({ url: restrictedUrl, title: "Restricted", publishedAtRaw: "2026-09-24", acquisitionKind: "webplus-detail" }),
      expect.objectContaining({ url: wechatUrl, title: "Public WeChat", publishedAtRaw: "2026-09-23", acquisitionKind: "public-wechat" }),
      expect.objectContaining({ url: externalUrl, title: "External", publishedAtRaw: "2026-09-22", acquisitionKind: "external-public" }),
    ]);
    expect(requested).toEqual([listUrl]);
  });
});
