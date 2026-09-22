import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRawDocument } from "./fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRawDocument", () => {
  it("captures ETag and Last-Modified response validators", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("<html>ok</html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            etag: '"abc123"',
            "last-modified": "Tue, 22 Sep 2026 12:00:00 GMT",
          },
        });
      }),
    );

    const document = await fetchRawDocument(
      "nju-test",
      "https://example.edu/list.htm",
    );

    expect(document.etag).toBe('"abc123"');
    expect(document.lastModified).toBe("Tue, 22 Sep 2026 12:00:00 GMT");
    expect(document.sha256).toHaveLength(64);
  });

  it("sends conditional headers and returns null on 304", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"abc123"');
      expect(headers.get("if-modified-since")).toBe(
        "Tue, 22 Sep 2026 12:00:00 GMT",
      );
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const document = await fetchRawDocument(
      "nju-test",
      "https://example.edu/list.htm",
      {
        etag: '"abc123"',
        lastModified: "Tue, 22 Sep 2026 12:00:00 GMT",
      },
    );

    expect(document).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries transient network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response("<html>ok</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const document = await fetchRawDocument(
      "nju-test",
      "https://example.edu/retry.htm",
    );

    expect(document.body).toBe("<html>ok</html>");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hashes original bytes and decodes legacy Chinese charsets", async () => {
    const gbkHello = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(gbkHello, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=gbk",
          },
        });
      }),
    );

    const document = await fetchRawDocument(
      "nju-test",
      "https://example.edu/legacy.htm",
    );

    expect(document.body).toBe("你好");
    expect(document.sha256).toBe(
      "6b5b97ebb913939e7f50ee8ce76ab9542af504a77485f63e7e0805d728322075",
    );
  });
});
