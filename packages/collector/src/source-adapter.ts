import {
  isBoshanSourceConfig,
  isJobPortalInformationSourceConfig,
} from "@nju-info/core";
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
import {
  discoverJobPortalInformationPage,
  jobPortalInformationDetailUrl,
  jobPortalInformationPageUrl,
  parseJobPortalInformationNotice,
} from "./job-portal-information.js";

export function initialSourcePageUrl(source: SourceConfig): string {
  if (isBoshanSourceConfig(source)) return boshanPageUrl(source, 1);
  if (isJobPortalInformationSourceConfig(source)) {
    return jobPortalInformationPageUrl(source, 1);
  }
  return source.url;
}

export function discoverSourcePage(
  raw: RawDocument,
  source: SourceConfig,
): DiscoveryPage {
  if (isBoshanSourceConfig(source)) return discoverBoshanPage(raw, source);
  if (isJobPortalInformationSourceConfig(source)) {
    return discoverJobPortalInformationPage(raw, source);
  }
  return discoverWebPlusPage(raw, source);
}

export function parseSourceNotice(
  raw: RawDocument,
  source: SourceConfig,
  discovered: DiscoveredItem,
): ParsedNotice {
  if (isBoshanSourceConfig(source)) {
    return parseBoshanNotice(raw, source, discovered);
  }
  if (isJobPortalInformationSourceConfig(source)) {
    return parseJobPortalInformationNotice(raw, source, discovered);
  }
  return parseWebPlusNotice(raw, source, discovered);
}

export function sourceDetailUrl(
  source: SourceConfig,
  discovered: DiscoveredItem,
): string {
  if (isJobPortalInformationSourceConfig(source)) {
    return jobPortalInformationDetailUrl(source, discovered.sourceItemId);
  }
  return discovered.url;
}
