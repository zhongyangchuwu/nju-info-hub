import { isBoshanSourceConfig } from "@nju-info/core";
import type {
  DiscoveredItem,
  DiscoveryPage,
  ParsedNotice,
  RawDocument,
  SourceConfig,
} from "@nju-info/core";
import {
  boshanPageUrl,
  discoverBoshanPage,
  parseBoshanNotice,
} from "./boshan.js";
import { discoverWebPlusPage, parseWebPlusNotice } from "./webplus.js";

export function initialSourcePageUrl(source: SourceConfig): string {
  return isBoshanSourceConfig(source)
    ? boshanPageUrl(source, 1)
    : source.url;
}

export function discoverSourcePage(
  raw: RawDocument,
  source: SourceConfig,
): DiscoveryPage {
  return isBoshanSourceConfig(source)
    ? discoverBoshanPage(raw, source)
    : discoverWebPlusPage(raw, source);
}

export function parseSourceNotice(
  raw: RawDocument,
  source: SourceConfig,
  discovered: DiscoveredItem,
): ParsedNotice {
  return isBoshanSourceConfig(source)
    ? parseBoshanNotice(raw, source, discovered)
    : parseWebPlusNotice(raw, source, discovered);
}
