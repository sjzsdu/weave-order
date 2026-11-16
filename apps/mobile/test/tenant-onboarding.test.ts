import { ApiError } from "@weave-order/core";
import { describe, expect, it } from "vitest";
import { needsTenantOnboarding } from "../src/lib/tenant-onboarding";

describe("移动端创建公司门禁", () => {
  it("账号已有公司或多租户选择时直接放行", async () => {
    await expect(
      needsTenantOnboarding(() => Promise.resolve({ tenant: { id: "tenant-1" } })),
    ).resolves.toBe(false);
    await expect(
      needsTenantOnboarding(() => Promise.resolve({ status: "MULTI_TENANT", tenants: [] })),
    ).resolves.toBe(false);
  });

  it("只有 NO_MEMBERSHIP 才进入创建公司页", async () => {
    const me = () => Promise.reject(new ApiError(403, "NO_MEMBERSHIP", "该账号还没有加入任何公司"));
    await expect(needsTenantOnboarding(me)).resolves.toBe(true);
  });

  it("网络错误和其他服务异常不能误判成无公司", async () => {
    const networkError = new Error("网络不可用");
    await expect(needsTenantOnboarding(() => Promise.reject(networkError))).rejects.toBe(
      networkError,
    );

    const serviceError = new ApiError(500, "INTERNAL", "服务暂时不可用");
    await expect(needsTenantOnboarding(() => Promise.reject(serviceError))).rejects.toBe(
      serviceError,
    );
  });
});
