import { describe, expect, it } from "vitest";
import type { KernelContext } from "../src/kernel";
import { isVisibleOwner, scopeWindowOf } from "../src/kernel/data-scope";
import { mayViewCost } from "../src/kernel/mappers";
import { narrowPricingContext } from "../src/kernel/pricing-scope";
import { isKernelError } from "../src/kernel/errors";

/**
 * 数据范围 / 字段裁剪的纯函数层（不碰数据库）。
 * 真实 SQL 过滤见 data-scope.integration.test.ts。
 */

const SELF = "00000000-0000-4000-8000-0000000000a1";
const PEER = "00000000-0000-4000-8000-0000000000a2";
const TEAM = "00000000-0000-4000-8000-0000000000b1";

function human(patch: Partial<KernelContext> = {}): KernelContext {
  return {
    actor: { type: "HUMAN", id: "casdoor-a", role: "SALES" },
    dataScope: "OWN",
    ownerId: SELF,
    teamId: null,
    ...patch,
  };
}

describe("scopeWindowOf", () => {
  it("没有 dataScope（系统/智能体内部）时不受限", () => {
    expect(scopeWindowOf(undefined)).toBeNull();
    expect(scopeWindowOf({ actor: { type: "AGENT", id: "agent" } })).toBeNull();
  });

  it("人类上下文带出 ownerId/teamId，缺省值归一为 null", () => {
    expect(scopeWindowOf(human())).toEqual({ dataScope: "OWN", ownerId: SELF, teamId: null });
  });
});

describe("isVisibleOwner", () => {
  it("ALL 与无上下文都能看到任何归属人的单据", () => {
    expect(isVisibleOwner(human({ dataScope: "ALL" }), PEER)).toBe(true);
    expect(isVisibleOwner(undefined, PEER)).toBe(true);
  });

  it("OWN 只能看到本人，且没有归属人的数据不可见（fail-closed）", () => {
    expect(isVisibleOwner(human(), SELF)).toBe(true);
    expect(isVisibleOwner(human(), PEER)).toBe(false);
    expect(isVisibleOwner(human(), null)).toBe(false);
  });

  it("TEAM 看同组；没配团队时退化为本人，不放大权限", () => {
    const team = human({ dataScope: "TEAM", teamId: TEAM });
    expect(isVisibleOwner(team, SELF)).toBe(true);
    expect(isVisibleOwner(team, PEER, new Set([SELF, PEER]))).toBe(true);
    expect(isVisibleOwner(team, PEER, new Set([SELF]))).toBe(false);
    const noTeam = human({ dataScope: "TEAM", teamId: null });
    expect(isVisibleOwner(noTeam, SELF)).toBe(true);
    expect(isVisibleOwner(noTeam, PEER)).toBe(false);
  });
});

describe("mayViewCost：成本底线按角色裁剪", () => {
  it("sales / merchandiser / sample_admin / viewer 不可见", () => {
    for (const role of ["SALES", "MERCHANDISER", "SAMPLE_ADMIN", "VIEWER"] as const) {
      expect(mayViewCost(role)).toBe(false);
    }
  });

  it("owner / manager / finance 可见；无角色（内核路径）可见", () => {
    for (const role of ["OWNER", "MANAGER", "FINANCE"] as const) {
      expect(mayViewCost(role)).toBe(true);
    }
    expect(mayViewCost(undefined)).toBe(true);
  });
});

describe("narrowPricingContext：resolve 作用域参数收紧", () => {
  it("业务员不传 personId 时默认只解析自己", () => {
    expect(narrowPricingContext({}, human())).toEqual({ personId: SELF });
  });

  it("业务员指定他人 personId → PERMISSION_DENIED", () => {
    try {
      narrowPricingContext({ personId: PEER }, human());
      throw new Error("应当拒绝");
    } catch (error) {
      expect(isKernelError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("PERMISSION_DENIED");
    }
  });

  it("teamId 只取成员归属，query 指定他组无效", () => {
    const context = narrowPricingContext(
      { teamId: "query-team", personId: SELF },
      human({ teamId: TEAM }),
    );
    expect(context.teamId).toBe(TEAM);
  });

  it("OWNER / MANAGER 可以跨人查看，且不默认塞自己的 personId", () => {
    const manager = human({
      actor: { type: "HUMAN", id: "casdoor-m", role: "MANAGER" },
      dataScope: "ALL",
      teamId: TEAM,
    });
    expect(narrowPricingContext({ personId: PEER }, manager)).toEqual({
      personId: PEER,
      teamId: TEAM,
    });
    expect(narrowPricingContext({}, manager)).toEqual({ teamId: TEAM });
  });

  it("没有范围上下文（本地演示/内部）保持原行为", () => {
    expect(narrowPricingContext({ personId: PEER, teamId: TEAM }, undefined)).toEqual({
      personId: PEER,
      teamId: TEAM,
    });
  });
});
