import { describe, expect, it } from "vitest";
import { normalizePublicationDate } from "./publication-date.js";

describe("normalizePublicationDate", () => {
  it.each([
    ["2026-9-21", "2026-09-21"],
    ["2026/09/21", "2026-09-21"],
    ["2026.09.21", "2026-09-21"],
    ["2026年9月21日", "2026-09-21"],
    ["09-21 2026", "2026-09-21"],
    ["2-29 2024", "2024-02-29"],
  ])("normalizes supported calendar date %s", (raw, expected) => {
    expect(normalizePublicationDate(raw)).toBe(expected);
  });

  it.each([null, undefined, "", "unknown", "2026-02-29", "13-01 2026", "2026-09-21T10:00:00Z"])(
    "does not invent a date for %s",
    (raw) => {
      expect(normalizePublicationDate(raw)).toBeNull();
    },
  );
});
