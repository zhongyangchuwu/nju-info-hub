import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSourceCommand } from "./source-command.js";

const sourceUrl = "https://stuex.nju.edu.cn/2539/list.htm";
const baseUrl = "https://stuex.nju.edu.cn";
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
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runSourceCommand([command, sourceId, ...args], sourceDirectory);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  return {
    output: stdout.mock.calls.map(([value]) => String(value)).join("\n"),
    errors: stderr.mock.calls.map(([value]) => String(value)).join("\n"),
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
    expect(result.errors).toContain(`nju-student-exchange ${detail("blocked")}: campus-network`);
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
      expect(result.errors).toContain(`${detail("ip-blocked")}: campus-network`);
      expect(result.errors).toContain(`${detail("auth-blocked")}: authentication`);
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
    expect(result.errors).toContain(`missing notice content for nju-student-exchange: ${detail("broken")}`);
    expect(result.errors).not.toContain("skipping restricted detail");
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
    expect(result.errors).toBe("");
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
      expect(result.errors).toContain(`nju-student-affairs-notices ${wechatUrl}: public-wechat`);
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
        [detail("new-one")]: { body: publicDetail("new-one") },
        [detail("new-two")]: { body: publicDetail("new-two") },
        [detail("new-three")]: { body: publicDetail("new-three") },
        [detail("known-newer")]: { body: publicDetail("known-newer") },
        [detail("known-older")]: { body: publicDetail("known-older") },
      });
      const incremental = await run("ingest", path, "2");
      expect(JSON.parse(incremental.output)).toMatchObject({
        pagesVisited: 2,
        itemsObserved: 5,
        noticesIngested: 5,
        insertedRevisions: 3,
        unchangedRevisions: 2,
        stats: { sourceItems: 5, noticeRevisions: 5 },
      });
      expect(requested).toEqual([
        sourceUrl,
        secondListUrl,
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

  it("persists the candidate observation before malformed detail parsing aborts ingest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-malformed-worker-"));
    const path = join(directory, "notices.sqlite");
    try {
      mockPages({
        [sourceUrl]: { body: list([{ name: "broken", date: "2026-09-24" }]) },
        [detail("broken")]: { body: "<h1>Broken article</h1>" },
      });
      const result = await run("ingest", path, "1");
      expect(result.errors).toContain(`missing notice content for nju-student-exchange: ${detail("broken")}`);
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
