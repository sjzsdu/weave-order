import { describe, expect, it } from "vitest";
import {
  Capability,
  MemberRole,
  PERSONA_KEYS,
  PERSONAS,
  Persona,
  PersonaKey,
  hasCapability,
  personaByKey,
  roleCapabilities,
} from "../src";
import type { MemberRole as Role } from "../src";

/**
 * persona 目录的 7 角色表。
 *
 * 期望值手写在本文件里，不 import 目录反推导：seed 写错角色、或有人把
 * 经理与业务员拆到不同 team，测试必须红。
 */
const EXPECTED: Record<
  (typeof PERSONA_KEYS)[number],
  { role: Role; dataScope: "ALL" | "TEAM" | "OWN"; sameTeamAs?: string }
> = {
  owner: { role: "OWNER", dataScope: "ALL" },
  manager: { role: "MANAGER", dataScope: "TEAM", sameTeamAs: "sales" },
  sales: { role: "SALES", dataScope: "OWN" },
  merchandiser: { role: "MERCHANDISER", dataScope: "TEAM", sameTeamAs: "sample_admin" },
  sample_admin: { role: "SAMPLE_ADMIN", dataScope: "TEAM" },
  finance: { role: "FINANCE", dataScope: "ALL" },
  viewer: { role: "VIEWER", dataScope: "ALL" },
};

describe("persona 目录：7 角色 table test", () => {
  it("恰好覆盖全部角色，每个角色一条", () => {
    expect(PERSONAS).toHaveLength(7);
    expect(PERSONAS.map((persona) => persona.role).sort()).toEqual([...MemberRole.options].sort());
    expect(PERSONAS.map((persona) => persona.key)).toEqual([...PERSONA_KEYS]);
  });

  it("字段、key、subject 都唯一且通过契约校验", () => {
    expect(() => Persona.array().parse(PERSONAS)).not.toThrow();
    expect(new Set(PERSONAS.map((persona) => persona.key)).size).toBe(7);
    expect(new Set(PERSONAS.map((persona) => persona.subject)).size).toBe(7);
  });

  it.each(PERSONAS)("$key → $role / $dataScope", (persona) => {
    const expected = EXPECTED[persona.key];
    expect(persona.role).toBe(expected.role);
    expect(persona.dataScope).toBe(expected.dataScope);
  });

  it("经理与业务员同 team：TEAM 范围才能覆盖业务员名下的客户", () => {
    const manager = personaByKey(PersonaKey.enum.manager);
    const sales = personaByKey(PersonaKey.enum.sales);
    expect(manager?.teamId).not.toBeNull();
    expect(manager?.teamId).toBe(sales?.teamId);
  });

  it.each(
    PERSONAS.filter((persona) => EXPECTED[persona.key].sameTeamAs).map((persona) => [
      persona.key,
      EXPECTED[persona.key].sameTeamAs as PersonaKey,
    ]),
  )("%s 与 %s 同 team", (key, peerKey) => {
    const persona = personaByKey(key);
    const peer = personaByKey(peerKey);
    expect(persona?.teamId).not.toBeNull();
    expect(persona?.teamId).toBe(peer?.teamId);
  });

  it.each(PERSONAS)("$key 的角色能力来自唯一能力表", (persona) => {
    const expected = Capability.options.filter((capability) =>
      hasCapability(persona.role, capability),
    );
    expect(roleCapabilities({ role: persona.role })).toEqual(expected);
  });

  it("未知 key 不会返回半条身份", () => {
    expect(personaByKey("nope" as PersonaKey)).toBeNull();
  });
});
