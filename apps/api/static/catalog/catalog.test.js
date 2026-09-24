import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpml, escapeXml, parseSourceSelection, serializeSourceSelection } from "./catalog-helpers.js";

const sources = [
  {
    id: "first",
    name: "A <title> & details",
    organization: { id: "org", name: 'School "A" & B' },
    home_page_url: "https://nju.example/a?x=1&y=2",
    feeds: {
      json: "https://feeds.example/a.json",
      atom: "https://feeds.example/a.atom",
      rss: "https://feeds.example/a.rss?one=1&two=2",
    },
  },
  {
    id: "second",
    name: "Second",
    organization: { id: "org", name: "School A" },
    home_page_url: "https://nju.example/b",
    feeds: { json: "https://feeds.example/b.json", atom: "https://feeds.example/b.atom", rss: "https://feeds.example/b.rss" },
  },
];

describe("static catalog helpers", () => {
  it("selects all only when the parameter is absent and ignores unknown or repeated IDs", () => {
    const ids = sources.map((source) => source.id);
    expect(parseSourceSelection(null, ids)).toEqual(["first", "second"]);
    expect(parseSourceSelection("second,unknown,first,second", ids)).toEqual(["first", "second"]);
    expect(parseSourceSelection("", ids)).toEqual([]);
  });

  it("serializes selected IDs without changing their catalog order", () => {
    expect(serializeSourceSelection(["first", "second"])).toBe("first,second");
  });

  it("escapes every XML special character", () => {
    expect(escapeXml(`<&>\"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("writes selected sources in supplied order with server-equivalent OPML 2.0 fields", () => {
    expect(buildOpml([sources[1], sources[0]])).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      '  <head><title>NJU Info Hub subscriptions</title></head>',
      '  <body>',
      '    <outline text="School A — Second" title="School A — Second" type="rss" xmlUrl="https://feeds.example/b.rss" htmlUrl="https://nju.example/b"/>',
      '    <outline text="School &quot;A&quot; &amp; B — A &lt;title&gt; &amp; details" title="School &quot;A&quot; &amp; B — A &lt;title&gt; &amp; details" type="rss" xmlUrl="https://feeds.example/a.rss?one=1&amp;two=2" htmlUrl="https://nju.example/a?x=1&amp;y=2"/>',
      '  </body>',
      '</opml>',
      '',
    ].join("\n"));
  });

  it("keeps the static document semantic, CSP-restricted, and free of inline code", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<main\b/);
    expect(html).toMatch(/<h1\b/);
    expect(html).toMatch(/aria-labelledby="sources-heading"/);
    expect(html.indexOf('id="sources-heading"')).toBeLessThan(html.indexOf('id="sets-heading"'));
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/);
    expect(html).toMatch(/default-src 'self'/);
    expect(html).toMatch(/<script type="module" src="\.\/app\.js"><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" href="\.\/styles\.css">/);
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });
});
