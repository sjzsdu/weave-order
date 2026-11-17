import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApprovalKind,
  OrderStatus,
  ReceivableBucket,
  ReviseQuoteDraftResult,
} from "@weave-order/schema";
import { CustomerListOptions, CustomerTimelineKind } from "@weave-order/schema";
import type { PricingKey } from "@weave-order/schema";
import { ZodError } from "zod";
import { createApprovalService } from "../approval";
import { isKernelError } from "../kernel";
import { narrowPricingContext } from "../kernel/pricing-scope";
import { QuoteAgentService } from "./quote-agent.service";
import type { Kernel } from "../kernel";
import { toToolError } from "../tools/errors";
import { findSchemaGap, schemaGapMessage } from "../platform/db-errors";
import { SchemaReadinessProbe } from "../platform/schema-readiness";
import type { AgentActorService } from "./agent-actor.service";
import type { HumanActorService } from "./human-actor.service";
import type { MediaService } from "../media/media.service";
import { AGENT_ACTOR, HUMAN_ACTOR, KERNEL, MEDIA_SERVICE, QUOTE_AGENT } from "./tokens";
import { ToolStatusInterceptor } from "./tool-status";

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function nonEmpty(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/** 状态筛选支持逗号分隔（漏斗「已发货」= SHIPPED,COMPLETED），非法值直接 400。 */
function parseStatuses(raw: string | undefined): OrderStatus[] | undefined {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => {
    const parsed = OrderStatus.safeParse(token);
    if (!parsed.success) throw new BadRequestException(`未知订单状态：${token}`);
    return parsed.data;
  });
}

function parseBucket(raw: string | undefined): ReceivableBucket {
  const parsed = ReceivableBucket.safeParse(nonEmpty(raw) ?? "all");
  if (!parsed.success) throw new BadRequestException(`未知应收分组：${raw}`);
  return parsed.data;
}

function parseDate(raw: string | undefined, field: string): Date | undefined {
  const value = nonEmpty(raw);
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} 不是合法时间：${value}`);
  }
  return date;
}

/** 内核错误 -> HTTP 状态；其余继续抛出，交给 Nest 统一处理。 */
export function rethrowHttp(error: unknown): never {
  // 契约校验失败是客户端错误，HTTP 面统一 400，不把它漏成 500。
  // 用形状判定而不是 instanceof：workspace 包可能各带一份 zod。
  if (isZodError(error)) {
    throw new BadRequestException(error.issues[0]?.message ?? "输入不合法");
  }
  if (isKernelError(error)) {
    if (error.code === "RESOURCE_NOT_FOUND" || error.code === "CUSTOMER_NOT_FOUND") {
      throw new NotFoundException(error.message);
    }
    if (error.code === "PERMISSION_DENIED") throw new ForbiddenException(error.message);
    // 编码唯一冲突是「请求本身没问题、与现有数据冲突」，必须 409 而不是 400。
    // 客户冲突额外带 `error.code`：前端据此提示「换个编号」，而不是解析人话。
    if (error.details.reason === "CUSTOMER_CODE_EXISTS") {
      throw new HttpException(
        {
          error: { code: "CUSTOMER_CODE_EXISTS", message: error.message },
          message: error.message,
        },
        HttpStatus.CONFLICT,
      );
    }
    if (error.details.reason === "SAMPLE_CODE_EXISTS") {
      throw new ConflictException(error.message);
    }
    // 意图已终结 / 超过撤销窗口：请求合法但与当前状态冲突，返回 409 让前端区分「重试无用」。
    if (
      error.details.reason === "INTENT_ALREADY_FINISHED" ||
      error.details.reason === "INTENT_CANCEL_WINDOW_EXPIRED"
    ) {
      throw new ConflictException(error.message);
    }
    throw new BadRequestException(error.message);
  }
  // 缺表 / 缺列是「服务还没部署完」，不是用户输入错：明确 503 并给出可执行的原因，
  // 否则前端只能显示「请求失败（HTTP 500）」，运维也不知道该跑迁移。
  const gap = findSchemaGap(error);
  if (gap) {
    const message = schemaGapMessage(gap);
    throw new HttpException(
      {
        // 缺对象与缺权限的运维动作不同（跑迁移 vs 补 GRANT），code 也要能分辨。
        error: {
          code: gap.kind === "denied" ? "DB_PRIVILEGE_MISSING" : "DB_SCHEMA_NOT_MIGRATED",
          message,
        },
        message,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  throw error;
}

function isZodError(error: unknown): error is ZodError {
  if (error instanceof ZodError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

@Controller("api")
export class HealthController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(SchemaReadinessProbe) private readonly schema: SchemaReadinessProbe,
  ) {}

  /**
   * 健康检查同时回答两件事：库通不通、结构是不是这一版要的结构。
   *
   * 状态码保持 200：容器探针不该因为「结构落后」把进程重启掉（那会把一个坏功能
   * 放大成整站不可用）。结构状态放在 `schema` 里，由发布验收与告警读取。
   */
  @Get("health")
  async health(): Promise<{
    ok: boolean;
    database: string;
    schema: { state: "ok" | "behind"; missing: string[]; denied: string[]; error?: string };
  }> {
    // 一次最小审计读取即证明 DB 可达，同时不碰业务数据。
    await this.kernel.audit.list(1);
    const readiness = await this.schema.check();
    return {
      ok: true,
      database: "up",
      schema: {
        state: readiness.ok ? "ok" : "behind",
        missing: readiness.missing,
        denied: readiness.denied,
        ...(readiness.error ? { error: readiness.error } : {}),
      },
    };
  }
}

/** 只读目录 + 找样工具。页面上的样品列表来自这里。 */
@Controller("api")
@UseInterceptors(ToolStatusInterceptor)
export class CatalogController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(AGENT_ACTOR) private readonly agent: AgentActorService,
  ) {}

  @Get("customers")
  async customers(
    @Query("limit") limit?: string,
    @Query("query") query?: string,
    @Query("owner") owner?: string,
    @Query("tier") tier?: string,
    @Query("overdue") overdue?: string,
    @Headers("authorization") authorization?: string,
  ) {
    const options = CustomerListOptions.parse({
      limit: clampLimit(limit, 50, 200),
      ...(query ? { query } : {}),
      ...(owner === "mine" || owner === "all" ? { owner } : {}),
      ...(tier ? { tier } : {}),
      ...(overdue === "1" || overdue === "true" ? { overdueOnly: true } : {}),
    });
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => ({
        customers: await kernel.customers.list(options, ctx),
      }),
      { scope: "read" },
    );
  }

  /** 客户 360 首屏：档案 + 上下文 + 聚合数字（与列表同一口径）。 */
  @Get("customers/:id")
  async customer360(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.customers.customer360(id, ctx),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /**
   * 新建客户。编号可省略：服务端按北京时间生成 `CYYMMDD-NNNN`。
   * 租户与负责人由登录态注入，请求体里出现这两个字段会被契约直接拒绝。
   */
  @Post("customers")
  async createCustomer(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({
          customer: await kernel.customers.createForHuman(body, ctx),
        }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 客户时间线：游标翻页，默认 20 条，可筛单据类型。 */
  @Get("customers/:id/timeline")
  async customerTimeline(
    @Param("id") id: string,
    @Query("types") types?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Headers("authorization") authorization?: string,
  ) {
    const kinds = (types ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => {
        const parsed = CustomerTimelineKind.safeParse(value);
        if (!parsed.success) {
          throw new BadRequestException(`未知的时间线类型：${value}`);
        }
        return parsed.data;
      });
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) =>
          kernel.customers.customerTimeline(
            id,
            { kinds, limit: clampLimit(limit, 20, 50), cursor: cursor ?? null },
            ctx,
          ),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("tools/search-by-spec")
  async searchBySpec(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.agent.run(authorization, this.kernel, (tools, ctx) =>
      tools.searchFabricBySpec.execute(body, ctx),
    );
  }

  @Post("tools/search-by-image")
  async searchByImage(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.agent.run(authorization, this.kernel, (tools, ctx) =>
      tools.searchFabricByImage.execute(body, ctx),
    );
  }

  /** 意图派发（Intent Bar）：建寄样单只能得到 DRAFT，确认走审批窗口。 */
  @Post("tools/create-sample-shipment")
  async createSampleShipment(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.agent.run(authorization, this.kernel, (tools, ctx) =>
      tools.createSampleShipment.execute(body, ctx),
    );
  }

  /** 客户 360：读客户档案 + 最近报价 / 订单 / 样品，供 CLI / agent 在报价前取上下文。 */
  @Post("tools/get-customer-history")
  async getCustomerHistory(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.agent.run(
      authorization,
      this.kernel,
      (tools, ctx) => tools.getCustomerHistory.execute(body, ctx),
      { scope: "read" },
    );
  }
}

/**
 * 报价草稿：智能体生成必须走工具。
 * 确认统一收口到审批窗口 `POST /api/approvals/decide` —— HTTP 面不再有
 * 第二个 HUMAN 上下文写路由，让「decide 是唯一入口」字面成立。
 */
@Controller("api")
@UseInterceptors(ToolStatusInterceptor)
export class QuoteController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(AGENT_ACTOR) private readonly agent: AgentActorService,
  ) {}

  @Post("tools/generate-quote-draft")
  async generateDraft(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.agent.run(authorization, this.kernel, (tools, ctx) =>
      tools.generateQuoteDraft.execute(body, ctx),
    );
  }

  /**
   * 建议单价（T-006）：只读计算，不落库。
   * 手机端没有成本底线字段，必须由内核给建议价，前端只负责把它回填到可编辑输入框。
   */
  @Post("tools/suggest-line-price")
  async suggestLinePrice(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.agent.run(
      authorization,
      this.kernel,
      (tools, ctx) => tools.suggestLinePrice.execute(body, ctx),
      { scope: "read" },
    );
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

  /** 单据详情：只读，批准 / 发送之后仍可读（生命周期状态在 `status`，不在草稿契约里）。 */
  @Get("quotes/:id")
  async quote(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(authorization, this.kernel, async (kernel, ctx) =>
        kernel.quotes.get(id, ctx),
      );
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
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return await kernel.pricing.listPage(
          {
            ...(scopeType ? { scopeType: scopeType as never } : {}),
            ...(scopeId ? { scopeId } : {}),
          },
          ctx,
          { limit: clampLimit(limit, 50, 200), cursor: cursor ?? null },
        );
      } catch (error) {
        rethrowHttp(error);
      }
    });
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
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
  ) {}

  @Get("orders")
  async list(
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
    @Query("dueFrom") dueFrom?: string,
    @Query("dueBefore") dueBefore?: string,
    @Query("overdueOnly") overdueOnly?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await kernel.workbench.listOrders(
            {
              statuses: parseStatuses(status),
              customerId: nonEmpty(customerId),
              dueFrom: parseDate(dueFrom, "dueFrom"),
              dueBefore: parseDate(dueBefore, "dueBefore"),
              overdueOnly: overdueOnly === "true" || overdueOnly === "1",
              cursor: nonEmpty(cursor) ?? null,
              limit: clampLimit(limit, 20, 50),
            },
            ctx,
          );
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
    );
  }

  /** 漏斗：与列表同一套筛选（不含状态），点数字进去条数刚好对上。 */
  @Get("orders/funnel")
  async funnel(
    @Query("customerId") customerId?: string,
    @Query("dueFrom") dueFrom?: string,
    @Query("dueBefore") dueBefore?: string,
    @Query("overdueOnly") overdueOnly?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await kernel.workbench.orderFunnel(
            {
              customerId: nonEmpty(customerId),
              dueFrom: parseDate(dueFrom, "dueFrom"),
              dueBefore: parseDate(dueBefore, "dueBefore"),
              overdueOnly: overdueOnly === "true" || overdueOnly === "1",
            },
            ctx,
          );
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
    );
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

  /** 订单详情工作面：行项目 / 关联报价 / 寄样记录 / 发货记录。 */
  @Get("orders/:id/workbench")
  async workbench(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await kernel.workbench.orderWorkbench(id, ctx);
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
    );
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
    @Query("cursor") cursor?: string,
    @Query("bucket") bucket?: string,
    @Query("customerId") customerId?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await kernel.workbench.listReceivables(
            {
              bucket: parseBucket(bucket),
              customerId: nonEmpty(customerId),
              cursor: nonEmpty(cursor) ?? null,
              limit: clampLimit(limit, 20, 50),
            },
            ctx,
          );
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
    );
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
        // 内核把刚插入的那笔流水一起返回：不按到账日倒序回查，
        // 补登历史回款时「倒序第一条」不是这一次。
        const { receivable, payment } = await kernel.receivables.recordPayment(input, ctx);
        return {
          receivable,
          payment: {
            id: payment.id,
            receivableId: payment.receivableId,
            amount: payment.amount,
            paidAt: payment.paidAt,
            note: payment.note,
            // 凭证 URL 只在这里签发，DB 里只存 object_key。
            proofUrl: payment.proofObjectKey
              ? await this.media.imageUrl(payment.proofObjectKey)
              : null,
            createdAt: payment.createdAt,
          },
        };
      } catch (error) {
        rethrowHttp(error);
      }
    });
  }

  /**
   * 客户对账单：哪几笔订单、哪几笔回款。
   * 打印与页面读同一份整数分汇总，没有第二套计算。
   */
  @Get("customers/:id/statement")
  async statement(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await kernel.workbench.customerStatement(
            id,
            {
              from: parseDate(from, "from"),
              to: parseDate(to, "to"),
            },
            (objectKey) => this.media.imageUrl(objectKey),
            ctx,
          );
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
    );
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
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  /**
   * 账本只读，且只看得到调用者自己租户：走 `HumanActorService` 既补上鉴权
   * （生产态缺凭据 401），也让 kernel 来自绑定租户的会话而不是演示租户。
   */
  @Get("audit")
  async list(@Query("limit") limit?: string, @Headers("authorization") authorization?: string) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel) => ({ entries: await kernel.audit.list(clampLimit(limit, 20, 200)) }),
      { scope: "read" },
    );
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
@UseInterceptors(ToolStatusInterceptor)
export class ApprovalController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get()
  async list(
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        try {
          return await createApprovalService(kernel).listPending(ctx, {
            limit: clampLimit(limit, 50, 100),
            cursor: cursor ?? null,
          });
        } catch (error) {
          rethrowHttp(error);
        }
      },
      { scope: "read" },
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
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        const detail = await createApprovalService(kernel).detail(id, parsed.data, ctx);
        if (!detail) {
          throw new NotFoundException({
            error: { code: "NOT_FOUND", message: "审批单据不存在或已不在可查看范围" },
          });
        }
        return detail;
      },
      { scope: "read" },
    );
  }

  @Post("decide")
  async decide(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    // 审批是唯一需要 approve 作用域的写操作：默认登录凭据没有它，
    // agent 无法用登录 token 自己批准自己。
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => createApprovalService(kernel).decide(body, ctx),
      { scope: "approve" },
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
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => createApprovalService(kernel).panorama(ctx),
      { scope: "read" },
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
