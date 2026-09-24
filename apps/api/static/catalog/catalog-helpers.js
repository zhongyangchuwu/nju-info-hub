export function parseSourceSelection(parameter, sourceIds) {
  if (parameter === null) return [...sourceIds];
  const requestedIds = new Set(parameter.split(","));
  return sourceIds.filter((id) => requestedIds.has(id));
}

export function serializeSourceSelection(sourceIds) {
  return sourceIds.join(",");
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

export function buildOpml(sources) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>NJU Info Hub subscriptions</title></head>',
    '  <body>',
    ...sources.map((source) => {
      const title = escapeXml(`${source.organization.name} — ${source.name}`);
      return `    <outline text="${title}" title="${title}" type="rss" xmlUrl="${escapeXml(source.feeds.rss)}" htmlUrl="${escapeXml(source.home_page_url)}"/>`;
    }),
    '  </body>',
    '</opml>',
    '',
  ].join("\n");
}
