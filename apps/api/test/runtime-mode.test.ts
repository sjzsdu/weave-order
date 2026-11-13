import { describe, expect, it } from "vitest";
import { isProductionLike } from "../src/platform/runtime-mode";

describe("生产态判定（所有 fail-fast 门控的唯一入口）", () => {
  it("NODE_ENV=production 或 AUTH_MODE=oidc 任一命中即为生产态", () => {
    expect(isProductionLike({ NODE_ENV: "production", AUTH_MODE: "dev" })).toBe(true);
    expect(isProductionLike({ NODE_ENV: "development", AUTH_MODE: "oidc" })).toBe(true);
    expect(isProductionLike({ NODE_ENV: "production", AUTH_MODE: "oidc" })).toBe(true);
  });

  it("本地 dev / test 不算生产态（允许占位值）", () => {
    expect(isProductionLike({ NODE_ENV: "development", AUTH_MODE: "dev" })).toBe(false);
    expect(isProductionLike({ NODE_ENV: "test", AUTH_MODE: "dev" })).toBe(false);
    expect(isProductionLike({})).toBe(false);
  });
});
