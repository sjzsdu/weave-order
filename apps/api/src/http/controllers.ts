import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import type { ApprovalService } from "../approval";
import type { Kernel } from "../kernel";
import type { Tools } from "../tools";
import { AGENT_CONTEXT, HUMAN_CONTEXT } from "./context";
import { APPROVAL, KERNEL, TOOLS } from "./tokens";

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

@Controller("api")
export class HealthController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Get("health")
  async health(): Promise<{ ok: boolean; database: string }> {
    // 一次最小审计读取即证明 DB 可达，同时不碰业务数据。
    await this.kernel.audit.list(1);
    return { ok: true, database: "up" };
  }
}

/** 只读目录 + 找样工具。页面上的样品列表来自这里。 */
@Controller("api")
export class CatalogController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(TOOLS) private readonly tools: Tools,
  ) {}

  @Get("customers")
  async customers(@Query("limit") limit?: string) {
    const rows = await this.kernel.customers.list(clampLimit(limit, 20, 100));
    return { customers: rows };
  }

  @Get("samples")
  async samples(@Query("limit") limit?: string) {
    const rows = await this.kernel.search.listSamples(clampLimit(limit, 50, 200));
    return { samples: rows };
  }

  @Post("tools/search-by-spec")
  async searchBySpec(@Body() body: unknown) {
    return this.tools.searchFabricBySpec.execute(body, AGENT_CONTEXT);
  }

  @Post("tools/search-by-image")
  async searchByImage(@Body() body: unknown) {
    return this.tools.searchFabricByImage.execute(body, AGENT_CONTEXT);
  }

  /** 意图派发（Intent Bar）：建寄样单只能得到 DRAFT，确认走审批窗口。 */
  @Post("tools/create-sample-shipment")
  async createSampleShipment(@Body() body: unknown) {
    return this.tools.createSampleShipment.execute(body, AGENT_CONTEXT);
  }
}

/**
 * 报价草稿：智能体生成必须走工具。
 * 确认统一收口到审批窗口 `POST /api/approvals/decide` —— HTTP 面不再有
 * 第二个 HUMAN 上下文写路由，让「decide 是唯一入口」字面成立。
 */
@Controller("api")
export class QuoteController {
  constructor(@Inject(TOOLS) private readonly tools: Tools) {}

  @Post("tools/generate-quote-draft")
  async generateDraft(@Body() body: unknown) {
    return this.tools.generateQuoteDraft.execute(body, AGENT_CONTEXT);
  }
}

/**
 * 数据导入（第六步）：Excel/CSV 冷启动的 HTTP 入口。
 * 入参是结构化 `ImportBatch`，每行由内核用 `packages/schema` 契约严格校验；
 * 控制器只固定传 HUMAN 上下文，不碰数据库、不写业务表、不绕过 kernel。
 */
@Controller("api")
export class ImportController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Post("import")
  async importBatch(@Body() body: unknown) {
    return this.kernel.importing.execute(body, HUMAN_CONTEXT);
  }
}

/** 审计流水（只读），页面用来展示「每一步都有记录」。 */
@Controller("api")
export class AuditController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Get("audit")
  async list(@Query("limit") limit?: string) {
    const entries = await this.kernel.audit.list(clampLimit(limit, 20, 200));
    return { entries };
  }
}

/**
 * 审批窗口（Review Queue）的 HTTP 面。
 *
 * 批准 / 拒绝是前端唯一的人类决策入口：控制器固定传入 HUMAN 上下文，
 * 由 approval 服务落到内核 confirm / reject，内核再校验 actor.type === "HUMAN"。
 * 前端拿不到内核句柄，也没有任何「直接改账本 / 绕过 tools」的端点。
 */
@Controller("api/approvals")
export class ApprovalController {
  constructor(@Inject(APPROVAL) private readonly approval: ApprovalService) {}

  @Get()
  async list() {
    return this.approval.listPending();
  }

  @Post("decide")
  async decide(@Body() body: unknown) {
    return this.approval.decide(body, HUMAN_CONTEXT);
  }
}

/** 业务全景（Read-Only Panorama）：一次只读聚合，前端纯展示，无任何写操作。 */
@Controller("api")
export class PanoramaController {
  constructor(@Inject(APPROVAL) private readonly approval: ApprovalService) {}

  @Get("panorama")
  async panorama() {
    return this.approval.panorama();
  }
}
