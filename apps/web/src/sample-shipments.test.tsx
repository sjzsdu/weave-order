import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "@weave-order/core";
import type { SampleShipmentRecord, SampleShipmentStatus } from "@weave-order/schema";
import {
  chunkSampleIds,
  fetchSampleShipments,
  pickSampleShipmentBadge,
  sampleShipmentSummaryText,
  summarizeSampleShipments,
  SampleShipmentBadge,
  SampleShipmentHistory,
} from "./sample-shipments";

const SAMPLE_A = "11111111-1111-4111-8111-111111111111";
const SAMPLE_B = "22222222-2222-4222-8222-222222222222";

let seq = 0;
function shipment(
  status: SampleShipmentStatus,
  options: {
    sampleIds?: string[];
    createdAt?: string;
    customerName?: string;
    trackingNumber?: string | null;
    carrier?: string | null;
    confirmedAt?: string | null;
  } = {},
): SampleShipmentRecord {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    code: `SS-${seq}`,
    status,
    carrier: options.carrier ?? null,
    trackingNumber: options.trackingNumber ?? null,
    customerId: "44444444-4444-4444-8444-444444444444",
    customerName: options.customerName ?? "天宝纺织",
    sampleIds: options.sampleIds ?? [SAMPLE_A],
    createdAt: options.createdAt ?? "2026-11-20T02:00:00.000Z",
    confirmedAt: options.confirmedAt ?? null,
  };
}

describe("图墙寄样徽标", () => {
  it("按关注优先级选一条：在途 > 已签收 > 待发货 > 草稿", () => {
    const rows = [
      shipment("DRAFT", { createdAt: "2026-11-24T00:00:00.000Z" }),
      shipment("CONFIRMED", { createdAt: "2026-11-23T00:00:00.000Z" }),
      shipment("DELIVERED", { createdAt: "2026-11-22T00:00:00.000Z" }),
      shipment("SHIPPED", { createdAt: "2026-11-21T00:00:00.000Z" }),
    ];
    expect(pickSampleShipmentBadge(rows, SAMPLE_A)?.label).toBe("在途待签收");

    const withoutShipped = rows.filter((row) => row.status !== "SHIPPED");
    expect(pickSampleShipmentBadge(withoutShipped, SAMPLE_A)?.label).toBe("已签收待回复");
  });

  it("同优先级取最近一单", () => {
    const older = shipment("SHIPPED", {
      createdAt: "2026-11-01T00:00:00.000Z",
      customerName: "旧客户",
    });
    const newer = shipment("SHIPPED", {
      createdAt: "2026-11-10T00:00:00.000Z",
      customerName: "新客户",
    });
    expect(pickSampleShipmentBadge([newer, older], SAMPLE_A)?.shipment.customerName).toBe("新客户");
    expect(pickSampleShipmentBadge([older, newer], SAMPLE_A)?.shipment.customerName).toBe("新客户");
  });

  it("没有寄样单、或只有已取消时不出徽标", () => {
    expect(pickSampleShipmentBadge([], SAMPLE_A)).toBeNull();
    const cancelled = [shipment("CANCELLED")];
    expect(pickSampleShipmentBadge(cancelled, SAMPLE_A)).toBeNull();
  });

  it("别的方法单不会串到这个样品上", () => {
    const other = shipment("SHIPPED", { sampleIds: [SAMPLE_B] });
    expect(pickSampleShipmentBadge([other], SAMPLE_A)).toBeNull();
  });

  it("徽标文案与人话状态一致，不带内部枚举", () => {
    const view = pickSampleShipmentBadge([shipment("CONFIRMED")], SAMPLE_A);
    if (!view) throw new Error("应命中徽标");
    const html = renderToStaticMarkup(<SampleShipmentBadge view={view} />);
    expect(html).toContain("已确认待发货");
    expect(html).not.toMatch(/SHIPPED|CONFIRMED|DRAFT/);
  });
});

describe("图墙顶部汇总", () => {
  it("数字只来自寄样单状态，不替智能体邀功", () => {
    const rows = [
      shipment("SHIPPED", { createdAt: "2026-11-24T00:00:00.000Z" }),
      shipment("SHIPPED", { createdAt: "2026-11-23T00:00:00.000Z" }),
      shipment("DELIVERED", { createdAt: "2026-11-22T00:00:00.000Z" }),
      shipment("CONFIRMED", { createdAt: "2026-11-21T00:00:00.000Z" }),
      shipment("DRAFT", { createdAt: "2026-11-20T00:00:00.000Z" }),
      shipment("CANCELLED"),
    ];
    const summary = summarizeSampleShipments(rows);
    expect(summary).toMatchObject({ total: 5, shipped: 2, delivered: 1, confirmed: 1, draft: 1 });
    const text = sampleShipmentSummaryText(summary);
    expect(text).toBe(
      "5 个寄样单还没结束：2 在途待签收，1 已签收待回复，1 已确认待发货，1 草稿待确认",
    );
    // WAN-216 的规矩：没有落库依据的话一句都不能说。
    expect(text).not.toMatch(/小织|正在追踪|智能体/);
  });

  it("同一张单出现多次只算一次", () => {
    const row = shipment("SHIPPED");
    const summary = summarizeSampleShipments([row, row, row]);
    expect(summary.total).toBe(1);
    expect(summary.shipped).toBe(1);
  });

  it("没有未结寄样单时也是一句实话", () => {
    const text = sampleShipmentSummaryText(summarizeSampleShipments([]));
    expect(text).toBe("当前图墙的样品没有未结的寄样单");
    expect(text).not.toMatch(/小织|追踪中/);
  });
});

describe("批量查询分片", () => {
  const ids = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );

  it("超过 100 个按上限分片，去重后不乱序", () => {
    const chunks = chunkSampleIds([...ids(130), ids(1)[0]!]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 30]);
    expect(chunks[0]![0]).toBe(ids(1)[0]);
    expect(chunks[1]![29]).toBe(ids(130)[129]);
  });

  it("跨分片的同一张单只保留一条", async () => {
    const first = ids(60);
    const second = ids(101).slice(60);
    const cross = shipment("SHIPPED", { sampleIds: [first[0]!, second[0]!] });
    const calls: string[][] = [];
    const api = {
      listSampleShipments: ({
        sampleIds,
      }: {
        sampleIds: string[];
      }): Promise<SampleShipmentRecord[]> => {
        calls.push([...sampleIds]);
        return Promise.resolve([cross]);
      },
    } as unknown as ApiClient;
    const result = await fetchSampleShipments(api, ids(101));
    expect(calls.map((chunk) => chunk.length)).toEqual([100, 1]);
    expect(result).toHaveLength(1);
  });
});

describe("样品抽屉·寄样记录", () => {
  it("空态说清「没寄过」，不装", () => {
    const html = renderToStaticMarkup(<SampleShipmentHistory shipments={[]} />);
    expect(html).toContain("寄样记录");
    expect(html).toContain("还没有寄给过客户");
    expect(html).not.toMatch(/小织|AI|智能体/);
  });

  it("有记录时客户名、状态、运单号、确认时间都在", () => {
    const row = shipment("CONFIRMED", {
      customerName: "天宝纺织",
      carrier: "顺丰",
      trackingNumber: "SF123456789",
      confirmedAt: "2026-11-22T03:00:00.000Z",
    });
    const html = renderToStaticMarkup(<SampleShipmentHistory shipments={[row]} />);
    expect(html).toContain("天宝纺织");
    expect(html).toContain("已确认待发货");
    expect(html).toContain("SF123456789");
    expect(html).toContain("复制");
    expect(html).toContain("确认于");
  });

  it("已取消也如实列出，不隐藏历史", () => {
    const html = renderToStaticMarkup(
      <SampleShipmentHistory shipments={[shipment("CANCELLED", { customerName: "旧客户" })]} />,
    );
    expect(html).toContain("已取消");
    expect(html).toContain("旧客户");
  });

  it("读取失败显示原因，不阻塞抽屉其余部分", () => {
    const html = renderToStaticMarkup(
      <SampleShipmentHistory shipments={undefined} error="寄样记录读取失败：网络错误" />,
    );
    expect(html).toContain("寄样记录读取失败：网络错误");
    expect(html).not.toContain("还没有寄给过客户");
  });
});
