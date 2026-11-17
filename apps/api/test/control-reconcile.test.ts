import { describe, expect, it, vi } from "vitest";
import {
  runReconcileOnce,
  createHttpControlPlane,
  type ControlPlane,
  type SyncTenant,
  type TenantSource,
} from "../src/platform/control-reconcile";

function resolved(): Promise<void>;
function resolved<T>(value: T): Promise<T>;
function resolved<T>(value?: T): Promise<T | void> {
  return Promise.resolve(value);
}

function fixture(tenants: SyncTenant[], controlSlugs: string[]) {
  const registered = vi.fn((_row: SyncTenant) => resolved());
  const ensureOutbox = vi.fn((_rows: SyncTenant[]) => resolved());
  const source: TenantSource = {
    listAuthoritativeTenants: () => resolved(tenants),
    ensureOutbox: (rows) => {
      void ensureOutbox(rows);
      return resolved();
    },
  };
  const control: ControlPlane = {
    listSlugs: () => resolved(new Set(controlSlugs)),
    register: (row) => {
      void registered(row);
      return resolved();
    },
  };
  return { source, control, registered, ensureOutbox };
}

const t = (slug: string): SyncTenant => ({
  tenantId: `id-${slug}`,
  slug,
  name: `公司 ${slug}`,
  ownerEmail: `${slug}@example.com`,
});

describe("双库对账", () => {
  it("无差异时不补登", async () => {
    const f = fixture([t("a"), t("b")], ["a", "b"]);
    const result = await runReconcileOnce(f.source, f.control);
    expect(result.repaired).toBe(0);
    expect(f.registered).not.toHaveBeenCalled();
    expect(result.authoritative).toBe(2);
  });

  it("业务库有、控制面无 → 自动补登并记入 repaired", async () => {
    const f = fixture([t("a"), t("b")], ["a"]);
    const result = await runReconcileOnce(f.source, f.control);
    expect(result.repaired).toBe(1);
    expect(f.registered).toHaveBeenCalledOnce();
    expect(f.registered).toHaveBeenCalledWith(t("b"));
  });

  it("控制面多出的租户只报告、绝不删除或补登", async () => {
    const f = fixture([t("a")], ["a", "ghost", "zombie"]);
    const result = await runReconcileOnce(f.source, f.control);
    expect(result.repaired).toBe(0);
    expect(f.registered).not.toHaveBeenCalled();
    expect(result.extraInControlPlane).toEqual(["ghost", "zombie"]);
  });

  it("对账始终确保所有权威租户都有 outbox 行", async () => {
    const f = fixture([t("a"), t("b")], ["a", "b"]);
    await runReconcileOnce(f.source, f.control);
    expect(f.ensureOutbox).toHaveBeenCalledWith([t("a"), t("b")]);
  });

  it("HTTP control plane：读 slugs 与补登都带共享密钥", async () => {
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (typeof url === "string" && url.includes("/slugs")) {
        return Promise.resolve(
          new Response(JSON.stringify({ slugs: [{ slug: "a" }] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 201 }));
    });
    const cp = createHttpControlPlane({
      baseUrl: "https://platform.example.test",
      secret: "k",
      fetchImpl,
    });
    expect([...(await cp.listSlugs())]).toEqual(["a"]);
    await cp.register(t("b"));
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "x-weave-internal": "k" });
    }
  });
});
