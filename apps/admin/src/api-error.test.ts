import { describe, expect, it } from "vitest";
import { ApiError, describeIssue, fieldLabel, toFormError } from "./api-error";

describe("控制面错误 → 中文文案", () => {
  it("Zod 校验错误不再展示「请求参数校验失败」，而是定位到字段", () => {
    const error = toFormError(
      new ApiError(400, "INVALID_INPUT", "请求参数校验失败", {
        issues: [
          {
            path: "prices.0.monthlyPriceCents",
            code: "too_small",
            message: "Number must be greater than or equal to 0",
            params: { minimum: 0, type: "number" },
          },
          {
            path: "planCode",
            code: "invalid_type",
            message: "Required",
            params: { received: "undefined" },
          },
        ],
        requestId: "12345678-abcd-0000-0000-000000000000",
      }),
    );

    expect(error.message).not.toContain("请求参数校验失败");
    expect(error.message).toBe("提交的内容有误，请按下方提示修改后重试");
    expect(error.fields).toEqual([
      { label: "价格表 第 1 项 月付价格", message: "不能小于 0" },
      { label: "套餐", message: "请填写" },
    ]);
  });

  it("无法自助恢复的内部错误保留短请求编号", () => {
    const error = toFormError(
      new ApiError(500, "INTERNAL", "控制面内部错误，请稍后重试", {
        requestId: "abcdef12-3456-7890-abcd-ef1234567890",
      }),
    );
    expect(error.message).toBe("控制面内部错误，请稍后重试（请求编号 abcdef12）");
  });

  it("中文业务错误原样保留，例如冲突说明", () => {
    const error = toFormError(new ApiError(409, "CONFLICT", "价格表版本已生效，不能重复提交"));
    expect(error.message).toBe("价格表版本已生效，不能重复提交");
  });

  it("400 INVALID_INPUT 带具体中文原因时原样展示，不退化为通用文案", () => {
    const reason = "没有生效价格，请先启用价格表或显式传价格";
    const error = toFormError(new ApiError(400, "INVALID_INPUT", reason));
    expect(error.message).toBe(reason);
    expect(error.fields).toEqual([]);
  });

  it("未映射的英文技术文案被替换成可执行提示", () => {
    const error = toFormError(new ApiError(500, "INTERNAL", "connect ECONNREFUSED 10.0.0.1:5432"));
    expect(error.message).toBe("服务暂时不可用，请稍后重试");
  });

  it("网络层异常提示检查网络", () => {
    expect(toFormError(new TypeError("Failed to fetch")).message).toBe(
      "网络连接失败，请检查网络后重试",
    );
  });
});

describe("字段路径与 Zod issue 翻译", () => {
  it("数组下标转成人类可读的项号", () => {
    expect(fieldLabel("prices.0.monthlyPriceCents")).toBe("价格表 第 1 项 月付价格");
    expect(fieldLabel("prices.0")).toBe("价格表 第 1 项");
    expect(fieldLabel("contactEmail")).toBe("联系邮箱");
    expect(fieldLabel([])).toBe("请求内容");
  });

  it("常见 Zod 错误码给中文动作", () => {
    expect(
      describeIssue({
        path: "a",
        code: "too_big",
        message: "x",
        params: { maximum: 10, type: "string" },
      }),
    ).toBe("不能超过 10 个字符");
    expect(
      describeIssue({
        path: "a",
        code: "invalid_string",
        message: "x",
        params: { validation: "email" },
      }),
    ).toBe("请输入有效的邮箱地址");
    expect(
      describeIssue({
        path: "a",
        code: "invalid_enum_value",
        message: "x",
        params: { options: ["PRO", "TEAM"] },
      }),
    ).toBe("请选择有效选项：PRO / TEAM");
    expect(describeIssue({ path: "a", code: "custom", message: "Required" })).toBe("格式不正确");
    expect(describeIssue({ path: "a", code: "custom", message: "价格不能为负" })).toBe(
      "价格不能为负",
    );
  });
});
