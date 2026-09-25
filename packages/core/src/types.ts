export interface RawDocument {
  sourceId: string;
  url: string;
  fetchedAt: string;
  contentType: string | null;
  body: string;
  sha256: string;
  etag?: string;
  lastModified?: string;
}

export type AcquisitionKind =
  | "webplus-detail"
  | "public-wechat"
  | "external-public";

export interface DiscoveredItem {
  sourceId: string;
  sourceItemId: string;
  url: string;
  acquisitionKind: AcquisitionKind;
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
  publishedOn: string | null;
  bodyText: string;
  bodyHtml: string;
  attachments: Attachment[];
  provenance: {
    fetchedAt: string;
    contentSha256: string;
  };
}
