import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApprovalKind, ReviseQuoteDraftResult } from "@weave-order/schema";
import type { PricingKey } from "@weave-order/schema";
import { createApprovalService } from "../approval";
import { isKernelError } from "../kernel";
import { narrowPricingContext } from "../kernel/pricing-scope";
import { QuoteAgentService } from "./quote-agent.service";
import type { Kernel } from "../kernel";
import type { Tools } from "../tools";
import { toToolError } from "../tools/errors";
import { AGENT_CONTEXT } from "./context";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL, QUOTE_AGENT, TOOLS } from "./tokens";

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
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("customers")
  async customers(
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      customers: await kernel.customers.list(clampLimit(limit, 20, 100), ctx),
    }));
  }

  @Get("samples")
  async samples(@Query("limit") limit?: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      samples: await kernel.search.listSamples(clampLimit(limit, 50, 200), ctx),
    }));
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
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Post("tools/generate-quote-draft")
  async generateDraft(@Body() body: unknown) {
    return this.tools.generateQuoteDraft.execute(body, AGENT_CONTEXT);
  }

  /** 人类改稿：版本 +1、重算、审计、改幅升级审批。 */
  @Post("quotes/revise")
  async revise(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const data = await kernel.quotes.reviseDraft(body, ctx);
        return ReviseQuoteDraftResult.parse({ ok: true, data });
      } catch (error) {
        if (isKernelError(error)) {
          return ReviseQuoteDraftResult.parse({ ok: false, error: toToolError(error) });
        }
        throw error;
      }
    });
  }

  /** 审批卡详情：只读，逐行 diff + 每个数字的出处。 */
  @Get("quotes/:id/approval-view")
  async approvalView(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
        view: await kernel.quotes.getApprovalView(id, ctx),
      }));
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("quotes/:id")
  async draft(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
        draft: await kernel.quotes.getDraft(id, ctx),
      }));
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

/** 定价继承：策略 CRUD + 生效值/来源解析。 */
@Controller("api/pricing")
export class PricingController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("policies")
  async list(
    @Query("scopeType") scopeType?: string,
    @Query("scopeId") scopeId?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      policies: await kernel.pricing.list(
        {
          ...(scopeType ? { scopeType: scopeType as never } : {}),
          ...(scopeId ? { scopeId } : {}),
        },
        ctx,
      ),
    }));
  }

  @Post("policies")
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { policy: await kernel.pricing.create(body, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Patch("policies/:id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { policy: await kernel.pricing.update(id, body, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  /** 生效值 + 来源：审批卡点开任意数字都调这里。 */
  @Get("resolve")
  async resolve(
    @Query("key") key: string,
    @Query("customerId") customerId?: string,
    @Query("teamId") teamId?: string,
    @Query("categoryId") categoryId?: string,
    @Query("personId") personId?: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
        resolved: await kernel.pricing.resolve(
          key as PricingKey,
          // teamId / personId 不再直接采信 query，统一按登录成员身份收敛。
          narrowPricingContext({ customerId, teamId, categoryId, personId }, ctx),
        ),
      }));
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

/** 订单 / 应收：报价成交后的后端链路。 */
@Controller("api")
export class OrderController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("orders")
  async list(@Query("limit") limit?: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      orders: await kernel.orders.list(clampLimit(limit, 20, 100), ctx),
    }));
  }

  @Get("orders/:id")
  async detail(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { order: await kernel.orders.getById(id, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Post("orders")
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { order: await kernel.orders.create(body, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Post("orders/:id/confirm")
  async confirm(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { order: await kernel.orders.confirm(id, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Get("receivables")
  async receivables(
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      receivables: await kernel.receivables.list(clampLimit(limit, 20, 100), ctx),
    }));
  }

  @Post("receivables")
  async createReceivable(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { receivable: await kernel.receivables.create(body, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Post("receivables/:id/payments")
  async recordPayment(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), receivableId: id };
        return { receivable: await kernel.receivables.recordPayment(input, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }
}

/** 决策增量与改稿原因：护城河数据只读查询 + 原因字典维护。 */
@Controller("api")
export class RevisionController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("customers/:id/decision-deltas")
  async decisionDeltas(
    @Param("id") id: string,
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
        deltas: await kernel.customers.listDecisionDeltas(id, clampLimit(limit, 50, 200), ctx),
      }));
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("revision-reasons")
  async reasons(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) => ({
      reasons: await kernel.revisions.list(),
    }));
  }

  @Post("revision-reasons")
  async createReason(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { reason: await kernel.revisions.create(body, ctx) };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  @Post("revision-reasons/defaults")
  async ensureDefaults(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      reasons: await kernel.revisions.ensureDefaults(ctx),
    }));
  }
}

/**
 * 数据导入（第六步）：Excel/CSV 冷启动的 HTTP 入口。
 * 入参是结构化 `ImportBatch`，每行由内核用 `packages/schema` 契约严格校验；
 * 控制器不碰数据库、不写业务表、不绕过 kernel。
 * 人类身份统一走 `HumanActorService`：生产态从 OIDC membership 注入真实角色与租户作用域，
 * 不再使用硬编码 OWNER 的占位上下文。
 */
@Controller("api")
export class ImportController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Post("import")
  async importBatch(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, (kernel, ctx) =>
      kernel.importing.execute(body, ctx),
    );
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
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get()
  async list(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) =>
      createApprovalService(kernel).listPending(ctx),
    );
  }

  /** 审批卡详情：出处 / diff / 草稿态，一次只读聚合。 */
  @Get(":id")
  async detail(
    @Param("id") id: string,
    @Query("kind") kind: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = ApprovalKind.safeParse(kind);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: "INVALID_INPUT", message: "kind 必须是 quote 或 sample_shipment" },
      });
    }
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      const detail = await createApprovalService(kernel).detail(id, parsed.data, ctx);
      if (!detail) {
        throw new NotFoundException({
          error: { code: "NOT_FOUND", message: "审批单据不存在或已不在可查看范围" },
        });
      }
      return detail;
    });
  }

  @Post("decide")
  async decide(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) =>
      createApprovalService(kernel).decide(body, ctx),
    );
  }
}

/** 业务全景（Read-Only Panorama）：一次只读聚合，前端纯展示，无任何写操作。 */
@Controller("api")
export class PanoramaController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get("panorama")
  async panorama(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) =>
      createApprovalService(kernel).panorama(ctx),
    );
  }
}

/**
 * 找样 / 报价 agent：粘贴客户原话，返回候选样品 + 定价依据 + DRAFT + 缺失项。
 * 这里没有「确认」入口 —— 草稿确认永远走审批窗口。
 */
@Controller("api/agents")
export class QuoteAgentController {
  constructor(@Inject(QUOTE_AGENT) private readonly agent: QuoteAgentService) {}

  @Post("quote")
  async quote(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.agent.run(authorization, body);
  }
}
