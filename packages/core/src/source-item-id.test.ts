import { describe, expect, it } from "vitest";
import { sourceItemIdFromUrl } from "./source-item-id.js";

describe("sourceItemIdFromUrl", () => {
  it("keeps existing URL-derived IDs byte-for-byte unchanged", () => {
    expect(sourceItemIdFromUrl("https://xgb.nju.edu.cn/e2/b3/c62106a844467/page.htm"))
      .toBe("3a146e473126e78d445b4a61");
  });
});
