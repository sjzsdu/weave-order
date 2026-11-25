import { BadRequestException, Controller, Get, Headers, Inject, Query } from "@nestjs/common";
import {
  EntityId,
  SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS,
  SampleShipmentStatus,
} from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

const STATUS_VALUES = SampleShipmentStatus.options.join(" / ");

/**
 * `sampleIds` 是逗号分隔的 UUID 列表。
 *
 * 超过上限直接 400 而不是截断：图墙按「已加载样品」批量查，静默丢掉后半段
 * 会让部分卡片凭空没有徽标，看起来像数据丢了。
 */
export function parseSampleShipmentSampleIds(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) {
    throw new BadRequestException("sampleIds 只能出现一次，多个样品请用逗号分隔");
  }
  if (raw === undefined || raw.trim() === "") {
    throw new BadRequestException("缺少 sampleIds：请传逗号分隔的样品 id");
  }
  const items = raw.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    throw new BadRequestException("sampleIds 里出现空值：请检查是否多打了逗号");
  }
  const unique = [...new Set(items)];
  if (unique.length > SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS) {
    throw new BadRequestException(
      `单次最多查询 ${SAMPLE_SHIPMENT_LOOKUP_MAX_SAMPLE_IDS} 个样品，当前 ${unique.length} 个`,
    );
  }
  for (const id of unique) {
    if (!EntityId.safeParse(id).success) {
      throw new BadRequestException(`样品 id 不是合法 UUID：${id}`);
    }
  }
  return unique;
}

export function parseSampleShipmentStatus(
  raw: string | string[] | undefined,
): SampleShipmentStatus | undefined {
  if (Array.isArray(raw)) {
    throw new BadRequestException("status 只能出现一次");
  }
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = SampleShipmentStatus.safeParse(raw.trim());
  if (!parsed.success) {
    throw new BadRequestException(`status 只接受 ${STATUS_VALUES}`);
  }
  return parsed.data;
}

/**
 * 寄样单只读面：样品图墙与样品抽屉都靠这一条回答「寄给过谁、到哪了」。
 *
 * 写路径不在本控制器：建单仍走 `/api/tools/create-sample-shipment`，
 * 确认 / 驳回仍归审批队列，两者都不在这里重复实现。
 */
@Controller("api")
export class SampleShipmentController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("sample-shipments")
  async list(
    @Query("sampleIds") sampleIds?: string | string[],
    @Query("status") status?: string | string[],
    @Headers("authorization") authorization?: string,
  ) {
    const ids = parseSampleShipmentSampleIds(sampleIds);
    const parsedStatus = parseSampleShipmentStatus(status);
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({
          shipments: await kernel.shipments.listBySampleIds(ids, ctx, parsedStatus),
        }),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
