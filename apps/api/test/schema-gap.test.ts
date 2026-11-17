import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { findSchemaGap, schemaGapMessage } from "../src/platform/db-errors";
import { rethrowHttp } from "../src/http/controllers";

/** 形状对齐 drizzle 的包装：真错误在 cause 链里，外层只有一句 query 摘要。 */
function wrappedPgError(code: string, message: string): Error {
  const pgError = Object.assign(new Error(message), { code });
  return Object.assign(new Error("Failed query: select * from intents"), { cause: pgError });
}

describe("缺表/缺列的识别", () => {
  it("沿 cause 链认出 undefined_table 并取出表名", () => {
    const gap = findSchemaGap(wrappedPgError("42P01", 'relation "intents" does not exist'));
    expect(gap).toEqual({ code: "42P01", kind: "missing", target: "intents" });
  });

  it("认出缺列并取出列名", () => {
    const gap = findSchemaGap(
      wrappedPgError("42703", 'column "executor_state" of relation "intents" does not exist'),
    );
    expect(gap?.target).toBe("executor_state");
  });

  it("业务错误不会被误判成结构缺口", () => {
    expect(findSchemaGap(new Error("客户编号已存在"))).toBeNull();
    expect(findSchemaGap(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBeNull();
  });

  it("人话里带上缺失对象，并说明该找管理员", () => {
    const message = schemaGapMessage({ code: "42P01", kind: "missing", target: "intents" });
    expect(message).toContain("intents");
    expect(message).toContain("数据库还没升级");
    expect(message).toContain("管理员");
  });

  it("表在但没权限 -> denied，文案说的是权限而不是迁移", () => {
    const gap = findSchemaGap(wrappedPgError("42501", "permission denied for table intents"));
    expect(gap).toEqual({ code: "42501", kind: "denied", target: "intents" });
    expect(schemaGapMessage(gap!)).toContain("数据库权限还没配置好");
  });
});

describe("HTTP 面把结构缺口翻成 503", () => {
  it("缺表 -> 503 + DB_SCHEMA_NOT_MIGRATED，而不是 500", () => {
    let caught: unknown;
    try {
      rethrowHttp(wrappedPgError("42P01", 'relation "intents" does not exist'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(503);
    const body = exception.getResponse() as { error: { code: string; message: string } };
    // 客户端 api-client 只认 { error: { code, message } } 这一种形状。
    expect(body.error.code).toBe("DB_SCHEMA_NOT_MIGRATED");
    expect(body.error.message).toContain("intents");
  });

  it("非结构错误原样抛出，交给 Nest 默认处理", () => {
    const original = new Error("boom");
    expect(() => rethrowHttp(original)).toThrow(original);
  });

  it("权限缺失 -> 503 + DB_PRIVILEGE_MISSING（WAN-147 的真实形态）", () => {
    let caught: unknown;
    try {
      rethrowHttp(wrappedPgError("42501", "permission denied for table intents"));
    } catch (error) {
      caught = error;
    }
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(503);
    const body = exception.getResponse() as { error: { code: string } };
    expect(body.error.code).toBe("DB_PRIVILEGE_MISSING");
  });
});
