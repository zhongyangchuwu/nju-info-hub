export interface RawDocument {
  sourceId: string;
  url: string;
  fetchedAt: string;
  contentType: string | null;
  body: string;
  sha256: string;
}

export interface DiscoveredItem {
  sourceId: string;
  url: string;
  title: string;
  publishedAtRaw?: string;
}

export interface DiscoveryPage {
  items: DiscoveredItem[];
  nextPageUrl?: string;
  lastPageUrl?: string;
  currentPage?: number;
  totalPages?: number;
}

export interface Attachment {
  url: string;
  title: string;
  mediaType?: string;
}

export interface ParsedNotice {
  sourceId: string;
  sourceItemId: string;
  url: string;
  title: string;
  publishedAtRaw?: string;
  bodyText: string;
  bodyHtml: string;
  attachments: Attachment[];
  provenance: {
    fetchedAt: string;
    contentSha256: string;
  };
}
