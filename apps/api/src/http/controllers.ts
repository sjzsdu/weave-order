import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ReviseQuoteDraftResult } from "@weave-order/schema";
import type { PricingKey } from "@weave-order/schema";
import type { ApprovalService } from "../approval";
import { isKernelError } from "../kernel";
import type { Kernel } from "../kernel";
import type { Tools } from "../tools";
import { toToolError } from "../tools/errors";
import { AGENT_CONTEXT, HUMAN_CONTEXT } from "./context";
import { APPROVAL, KERNEL, TOOLS } from "./tokens";

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

/** 内核错误 -> HTTP 状态；其余继续抛出，交给 Nest 统一处理。 */
function rethrowHttp(error: unknown): never {
  if (isKernelError(error)) {
    if (error.code === "RESOURCE_NOT_FOUND" || error.code === "CUSTOMER_NOT_FOUND") {
      throw new NotFoundException(error.message);
    }
    if (error.code === "PERMISSION_DENIED") throw new ForbiddenException(error.message);
    throw new BadRequestException(error.message);
  }
  throw error;
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
  constructor(
    @Inject(TOOLS) private readonly tools: Tools,
    @Inject(KERNEL) private readonly kernel: Kernel,
  ) {}

  @Post("tools/generate-quote-draft")
  async generateDraft(@Body() body: unknown) {
    return this.tools.generateQuoteDraft.execute(body, AGENT_CONTEXT);
  }

  /** 人类改稿：版本 +1、重算、审计、改幅升级审批。 */
  @Post("quotes/revise")
  async revise(@Body() body: unknown) {
    try {
      const data = await this.kernel.quotes.reviseDraft(body, HUMAN_CONTEXT);
      return ReviseQuoteDraftResult.parse({ ok: true, data });
    } catch (error) {
      if (isKernelError(error)) {
        return ReviseQuoteDraftResult.parse({ ok: false, error: toToolError(error) });
      }
      throw error;
    }
  }

  /** 审批卡详情：只读，逐行 diff + 每个数字的出处。 */
  @Get("quotes/:id/approval-view")
  async approvalView(@Param("id") id: string) {
    try {
      return { view: await this.kernel.quotes.getApprovalView(id) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("quotes/:id")
  async draft(@Param("id") id: string) {
    try {
      return { draft: await this.kernel.quotes.getDraft(id) };
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

/** 定价继承：策略 CRUD + 生效值/来源解析。 */
@Controller("api/pricing")
export class PricingController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Get("policies")
  async list(@Query("scopeType") scopeType?: string, @Query("scopeId") scopeId?: string) {
    const policies = await this.kernel.pricing.list({
      ...(scopeType ? { scopeType: scopeType as never } : {}),
      ...(scopeId ? { scopeId } : {}),
    });
    return { policies };
  }

  @Post("policies")
  async create(@Body() body: unknown) {
    try {
      return {
        policy: await this.kernel.pricing.create(body, {
          ...HUMAN_CONTEXT,
          actor: { ...HUMAN_CONTEXT.actor, type: "HUMAN" },
        }),
      };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Patch("policies/:id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    try {
      return { policy: await this.kernel.pricing.update(id, body, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 生效值 + 来源：审批卡点开任意数字都调这里。 */
  @Get("resolve")
  async resolve(
    @Query("key") key: string,
    @Query("customerId") customerId?: string,
    @Query("teamId") teamId?: string,
    @Query("categoryId") categoryId?: string,
    @Query("personId") personId?: string,
  ) {
    try {
      const resolved = await this.kernel.pricing.resolve(key as PricingKey, {
        ...(customerId ? { customerId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(personId ? { personId } : {}),
      });
      return { resolved };
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

/** 订单 / 应收：报价成交后的后端链路。 */
@Controller("api")
export class OrderController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Get("orders")
  async list(@Query("limit") limit?: string) {
    return { orders: await this.kernel.orders.list(clampLimit(limit, 20, 100)) };
  }

  @Post("orders")
  async create(@Body() body: unknown) {
    try {
      return { order: await this.kernel.orders.create(body, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("orders/:id/confirm")
  async confirm(@Param("id") id: string) {
    try {
      return { order: await this.kernel.orders.confirm(id, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("receivables")
  async receivables(@Query("limit") limit?: string) {
    return { receivables: await this.kernel.receivables.list(clampLimit(limit, 20, 100)) };
  }

  @Post("receivables")
  async createReceivable(@Body() body: unknown) {
    try {
      return { receivable: await this.kernel.receivables.create(body, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("receivables/:id/payments")
  async recordPayment(@Param("id") id: string, @Body() body: unknown) {
    try {
      const input = { ...(body as Record<string, unknown>), receivableId: id };
      return { receivable: await this.kernel.receivables.recordPayment(input, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

/** 决策增量与改稿原因：护城河数据只读查询 + 原因字典维护。 */
@Controller("api")
export class RevisionController {
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  @Get("customers/:id/decision-deltas")
  async decisionDeltas(@Param("id") id: string, @Query("limit") limit?: string) {
    try {
      return {
        deltas: await this.kernel.customers.listDecisionDeltas(id, clampLimit(limit, 50, 200)),
      };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("revision-reasons")
  async reasons() {
    return { reasons: await this.kernel.revisions.list() };
  }

  @Post("revision-reasons")
  async createReason(@Body() body: unknown) {
    try {
      return { reason: await this.kernel.revisions.create(body, HUMAN_CONTEXT) };
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("revision-reasons/defaults")
  async ensureDefaults() {
    return { reasons: await this.kernel.revisions.ensureDefaults(HUMAN_CONTEXT) };
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
