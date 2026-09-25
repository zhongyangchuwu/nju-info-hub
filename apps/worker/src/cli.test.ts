import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const sourceUrl = "https://stuex.nju.edu.cn/2539/list.htm";
const baseUrl = "https://stuex.nju.edu.cn";
const detail = (name: string) => `${baseUrl}/${name}/page.htm`;
const restriction = readFileSync(
  new URL("../../../packages/collector/fixtures/webplus/campus-restricted.html", import.meta.url),
  "utf8",
);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

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
  process.argv = ["node", "cli.ts", command, sourceId, ...args];
  vi.resetModules();
  // CLI work begins on module evaluation; static import would run before argv/fetch are set.
  await import("./cli.js");
  await vi.waitFor(() =>
    expect(stdout.mock.calls.length + (process.exitCode === 1 ? stderr.mock.calls.length : 0))
      .toBeGreaterThan(0),
  );
  return {
    output: stdout.mock.calls.map(([value]) => String(value)).join("\n"),
    errors: stderr.mock.calls.map(([value]) => String(value)).join("\n"),
  };
}

function run(command: string, ...args: string[]) {
  return runSource("nju-student-exchange", command, ...args);
}

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("worker restricted details", () => {
  it("skips the newest IP-restricted item, preserving dated recency and one-page-beyond ordering", async () => {
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
      [detail("public-old")]: { body: publicDetail("public-old") },
    });

    const result = await run("fetch", "2");
    expect(JSON.parse(result.output).map((notice: { title: string }) => notice.title)).toEqual([
      "public-new",
      "public-old",
    ]);
    expect(result.errors).toContain(`nju-student-exchange ${detail("blocked")}: campus-network`);
    expect(requested).toEqual([
      sourceUrl,
      `${baseUrl}/2539/list2.htm`,
      detail("blocked"),
      detail("public-new"),
      detail("public-old"),
    ]);
  });

  it("observes only the two candidates attempted after recency lookahead", async () => {
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
        itemsDiscovered: 2,
        noticesIngested: 2,
        stats: { sourceItems: 2, sourceItemObservations: 2, noticeRevisions: 2 },
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
          { url: detail("lookahead-newest"), list_url: secondListUrl },
          { url: detail("newer"), list_url: sourceUrl },
        ]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues beyond the initial one-page window for multiple restrictions and persists only public details", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nju-restricted-worker-"));
    const path = join(directory, "notices.sqlite");
    try {
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
        [`${baseUrl}/2539/list2.htm`]: {
          body: list([{ name: "ip-blocked-two", date: "2026-09-22" }], "/2539/list3.htm"),
        },
        [`${baseUrl}/2539/list3.htm`]: {
          body: list([
            { name: "public-first", date: "2026-09-21" },
            { name: "public-second", date: "2026-09-20" },
          ]),
        },
        [detail("ip-blocked")]: { body: restriction },
        [detail("auth-blocked")]: {
          body: "<html>Sign in</html>",
          finalUrl: "https://authserver.nju.edu.cn/authserver/login?service=test",
        },
        [detail("ip-blocked-two")]: { body: restriction },
        [detail("public-first")]: { body: publicDetail("public-first") },
        [detail("public-second")]: { body: publicDetail("public-second") },
      });

      const result = await run("ingest", path, "2");
      const summary = JSON.parse(result.output);
      expect(summary.itemsDiscovered).toBe(5);
      expect(summary.noticesIngested).toBe(2);
      expect(summary.insertedRevisions).toBe(2);
      expect(result.errors).toContain(`${detail("ip-blocked")}: campus-network`);
      expect(result.errors).toContain(`${detail("auth-blocked")}: authentication`);
      expect(result.errors).toContain(`${detail("ip-blocked-two")}: campus-network`);
      expect(requested).toContain(`${baseUrl}/2539/list3.htm`);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT url FROM source_items ORDER BY url").all()).toEqual([
          { url: detail("auth-blocked") },
          { url: detail("ip-blocked-two") },
          { url: detail("ip-blocked") },
          { url: detail("public-first") },
          { url: detail("public-second") },
        ]);
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get()).toEqual({ count: 5 });
        expect(
          database.prepare(`
            SELECT source_items.url, raw_documents.final_url AS list_url
            FROM source_item_observations
            JOIN source_items ON source_items.id = source_item_observations.source_item_row_id
            JOIN raw_documents ON raw_documents.id = source_item_observations.raw_document_id
            ORDER BY source_items.url
          `).all(),
        ).toEqual([
          { url: detail("auth-blocked"), list_url: sourceUrl },
          { url: detail("ip-blocked-two"), list_url: `${baseUrl}/2539/list2.htm` },
          { url: detail("ip-blocked"), list_url: sourceUrl },
          { url: detail("public-first"), list_url: `${baseUrl}/2539/list3.htm` },
          { url: detail("public-second"), list_url: `${baseUrl}/2539/list3.htm` },
        ]);
        expect(database.prepare("SELECT count(*) AS count FROM notice_revisions").get()).toEqual({ count: 2 });
        expect(
          database.prepare("SELECT final_url FROM raw_documents WHERE final_url LIKE '%/page.htm' ORDER BY final_url").all(),
        ).toEqual([
          { final_url: detail("public-first") },
          { final_url: detail("public-second") },
        ]);
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

  it("skips an official public-WeChat row without requesting it and refills from older WebPlus rows", async () => {
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
        [second]: { body: publicDetail("Second public") },
      });
      const result = await runSource("nju-student-affairs-notices", "ingest", path, "2");
      expect(JSON.parse(result.output)).toMatchObject({
        itemsDiscovered: 3,
        noticesIngested: 2,
        insertedRevisions: 2,
      });
      expect(result.errors).toContain(`nju-student-affairs-notices ${wechatUrl}: public-wechat`);
      expect(requested).toEqual([listUrl, first, second]);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT url FROM source_items ORDER BY url").all()).toEqual([
          { url: wechatUrl },
          { url: first },
          { url: second },
        ]);
        expect(database.prepare("SELECT count(*) AS count FROM source_item_observations").get()).toEqual({ count: 3 });
        expect(
          database.prepare(`
            SELECT DISTINCT raw_documents.final_url
            FROM source_item_observations
            JOIN raw_documents ON raw_documents.id = source_item_observations.raw_document_id
          `).all(),
        ).toEqual([{ final_url: listUrl }]);
      } finally {
        database.close();
      }
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
