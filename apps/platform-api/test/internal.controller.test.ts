import { describe, expect, it, vi } from "vitest";
import { InternalController } from "../src/http/internal.controller";
import { DEV_ONBOARDING_SECRET } from "../src/control/onboarding-ticket";
import type { TenantsService } from "../src/control/tenants.service";

function controllerWith(spy: ReturnType<typeof vi.fn>) {
  return new InternalController({ registerTrialTenant: spy } as unknown as TenantsService);
}

const body = { slug: "t-abc123", name: "青禾纺织", ownerEmail: "boss@example.com" };

describe("控制面内部登记接口", () => {
  it("凭据不对时拒绝", async () => {
    const spy = vi.fn();
    await expect(controllerWith(spy).register("wrong-secret", body)).rejects.toMatchObject({
      status: 401,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("缺凭据时拒绝", async () => {
    const spy = vi.fn();
    await expect(controllerWith(spy).register(undefined, body)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("参数不合法时拒绝", async () => {
    const spy = vi.fn();
    await expect(
      controllerWith(spy).register(DEV_ONBOARDING_SECRET, { slug: "大写非法", name: "" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("凭据正确时登记试用租户", async () => {
    const spy = vi.fn().mockResolvedValue({ tenantId: "id-1", slug: body.slug, created: true });
    const result = await controllerWith(spy).register(DEV_ONBOARDING_SECRET, body);
    expect(spy).toHaveBeenCalledWith(body);
    expect(result).toEqual({ tenantId: "id-1", slug: body.slug, created: true });
  });
});

describe("控制面对账 slug 接口", () => {
  function controllerWithSlugs(spy: ReturnType<typeof vi.fn>) {
    return new InternalController({
      listControlSlugs: spy,
    } as unknown as TenantsService);
  }

  it("凭据不对时拒绝", async () => {
    const spy = vi.fn();
    await expect(controllerWithSlugs(spy).slugs("wrong")).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("凭据正确时返回控制面已知 slug 集合", async () => {
    const spy = vi.fn().mockResolvedValue([{ slug: "a", status: "TRIAL" }]);
    const result = await controllerWithSlugs(spy).slugs(DEV_ONBOARDING_SECRET);
    expect(result).toEqual({ slugs: [{ slug: "a", status: "TRIAL" }] });
  });
});
