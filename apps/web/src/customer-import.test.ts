import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS } from "@weave-order/schema";
import {
  CUSTOMER_CSV_TEMPLATE,
  decodeCsvBytes,
  importRowErrorText,
  parseCustomerCsv,
  parseCsvRecords,
} from "./customer-import";

describe("parseCsvRecords", () => {
  it("去掉 BOM，支持引号里的逗号、换行与双引号转义", () => {
    const records = parseCsvRecords(
      '\uFEFFcode,name\r\nC1,"杭州,青禾"\r\nC2,"两行\n名字"\r\nC3,"说""好"""\r\n',
    );
    expect(records).toEqual([
      ["code", "name"],
      ["C1", "杭州,青禾"],
      ["C2", "两行\n名字"],
      ["C3", '说"好"'],
    ]);
  });
});

describe("parseCustomerCsv", () => {
  it("模板能被自己的解析器读回来，且示例行字段映射正确", () => {
    const parsed = parseCustomerCsv(CUSTOMER_CSV_TEMPLATE);
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.values).toMatchObject({
      code: "C0001",
      name: "杭州青禾（示例）",
      tier: "NEW",
      contactName: "周敏",
      contactPhone: "13800000000",
    });
    // 模板里的空邮箱不提交空字符串，交给服务端按可选处理。
    expect(parsed.rows[0]?.values).not.toHaveProperty("contactEmail");
  });

  it("中文表头与中文等级也认", () => {
    const parsed = parseCustomerCsv("客户编号,名称,等级,联系人\nC9,青禾,VIP,周敏\n");
    expect(parsed.error).toBeNull();
    expect(parsed.rows[0]?.values).toMatchObject({ code: "C9", name: "青禾", tier: "VIP" });
  });

  it("表头缺必填列 / 有陌生列时直接拒绝，不猜", () => {
    expect(parseCustomerCsv("code,tier\nC1,NEW\n").error).toContain("name");
    expect(parseCustomerCsv("code,name,unknown\nC1,青禾,x\n").error).toContain("unknown");
  });

  it("超过单批行数上限时给出拆分提示", () => {
    const lines = ["code,name"];
    for (let index = 0; index < MAX_IMPORT_ROWS + 1; index += 1) {
      lines.push(`C${index},客户${index}`);
    }
    const parsed = parseCustomerCsv(lines.join("\n"));
    expect(parsed.error).toContain(String(MAX_IMPORT_ROWS));
    expect(parsed.rows).toHaveLength(MAX_IMPORT_ROWS + 1);
  });

  it("空行被跳过并计数，不占回执行号", () => {
    const parsed = parseCustomerCsv("code,name\nC1,甲\n\nC2,乙\n");
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 4]);
    expect(parsed.skippedBlankRows).toBe(1);
  });
});

describe("decodeCsvBytes", () => {
  it("UTF-8 正常解码", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("code,name\nC1,青禾"))).toContain("青禾");
  });
});

describe("importRowErrorText", () => {
  it("把可判别 code 翻成中文原因", () => {
    expect(
      importRowErrorText({
        code: "INVALID_INPUT",
        message: "bad",
        issues: [
          {
            path: ["name"],
            code: "too_small",
            message: "String must contain at least 1 character(s)",
          },
        ],
      }),
    ).toBe("格式不对：客户名称必填");
    expect(
      importRowErrorText({ code: "DUPLICATE_IN_BATCH", message: "dup", conflictsWithRow: 0 }),
    ).toContain("第 2 行重复");
    expect(
      importRowErrorText({ code: "DUPLICATE_IN_DB", message: "dup", existingId: "id" }),
    ).toContain("已经存在");
  });
});
