import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { CreateShipmentInput, PrintDocumentKind, ReprintReason } from "@weave-order/schema";
import type {
  PrintCenterSnapshot,
  PrintJobBatchResult,
  PrintJobList,
  PrintLogEntry,
  PrintTemplateList,
  ShipmentView,
} from "@weave-order/schema";
import { isKernelError } from "../kernel";
import type { Kernel } from "../kernel";
import { PrintError } from "../print";
import { PrintAgentAuthService } from "../print/agent-auth.service";
import type { AgentDb, AgentIdentity } from "../print/agent-auth.service";
import { PrintAgentHub } from "../print/agent-hub";
import { PrintDeviceService } from "../print/print-devices.service";
import { PrintJobService } from "../print/print-jobs.service";
import { PrintTemplateService } from "../print/print-templates.service";
import { PrintViewService } from "../print/print-view.service";
import { SampleCardService } from "../print/sample-card.service";
import { loadEnv } from "../platform/env";
import { HUMAN_ACTOR, KERNEL } from "./tokens";
import type { HumanActorService } from "./human-actor.service";

function rethrowPrint(error: unknown): never {
  if (error instanceof PrintError) {
    if (error.code === "PRINT_AGENT_UNAUTHORIZED") {
      throw new UnauthorizedException({ error: { code: error.code, message: error.message } });
    }
    throw new BadRequestException({ error: { code: error.code, message: error.message } });
  }
  if (isKernelError(error)) {
    if (error.code === "RESOURCE_NOT_FOUND" || error.code === "CUSTOMER_NOT_FOUND") {
      throw new NotFoundException({
        error: { code: error.code, message: error.message, ...error.details },
      });
    }
    if (error.code === "PERMISSION_DENIED") {
      throw new ForbiddenException({ error: { code: error.code, message: error.message } });
    }
    throw new BadRequestException({
      error: { code: error.code, message: error.message, ...error.details },
    });
  }
  throw error;
}

/** 打印代理侧只需要 claim / report，但服务构造需要完整的组合根。 */
function printJobsFor(db: AgentDb, tenantId: string): PrintJobService {
  const env = loadEnv();
  const templates = new PrintTemplateService(db, tenantId);
  const sampleCards = new SampleCardService(
    db,
    tenantId,
    { shareSecret: env.QUOTE_SHARE_SECRET, publicAppUrl: env.PUBLIC_APP_URL },
    templates,
  );
  return new PrintJobService(
    db,
    tenantId,
    new PrintViewService(db, tenantId),
    templates,
    sampleCards,
  );
}

/**
 * 打印中心 HTTP 面（人工操作）。
 *
 * 所有写操作都经内核租户会话；打印中心只读业务表，写入自己的打印表。
 * 模板、任务、箱、扫码都留审计。
 */
@Controller("api")
export class PrintController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
    @Inject(PrintAgentHub) private readonly hub: PrintAgentHub,
  ) {}

  private attach(kernel: Kernel) {
    kernel.print.jobs.setDispatcher((input) => this.hub.dispatch(input));
    return kernel.print;
  }

  @Get("print/center")
  async center(@Headers("authorization") authorization?: string): Promise<PrintCenterSnapshot> {
    return this.human.run(authorization, this.kernel, async (kernel) =>
      this.attach(kernel).snapshot(),
    );
  }

  @Get("print/jobs")
  async jobs(
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<PrintJobList> {
    return this.human.run(authorization, this.kernel, async (kernel) =>
      this.attach(kernel).jobs.list({
        ...(status ? { status } : {}),
        limit: Number(limit) || 50,
      }),
    );
  }

  @Post("print/jobs")
  async enqueue(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const result = await this.attach(kernel).jobs.enqueue(body, ctx);
        return {
          job: result.job,
          deduplicated: result.deduplicated,
          message: result.deduplicated ? "已在队列：不会重复出纸" : "已入队：代理在线会自动打印",
        };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/preview")
  @HttpCode(200)
  async preview(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return {
          preview: await this.attach(kernel).sampleCards.preview(body, ctx.actor.id),
        };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Get("print/jobs/:id")
  async job(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) => {
      try {
        return { job: await this.attach(kernel).jobs.get(id) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  /** 一份报价的打印记录：抽取「补打」入口的数据。 */
  @Get("print/sample-cards/:quoteId")
  async sampleCardJobs(
    @Param("quoteId") quoteId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel) => {
      try {
        return { jobs: await this.attach(kernel).jobs.listForQuote(quoteId) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  /** 一键打全部样卡：报价每行一张，各自幂等。 */
  @Post("print/sample-cards/:quoteId")
  async printSampleCards(
    @Param("quoteId") quoteId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return await this.attach(kernel).jobs.printSampleCards(quoteId, body, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  /** 补打：必须选原因；不新建样品。 */
  @Post("print/sample-cards/:quoteId/reprint")
  async reprintSampleCard(
    @Param("quoteId") quoteId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return await this.attach(kernel).jobs.reprintSampleCard(quoteId, body, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/jobs/bundle")
  async bundle(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ): Promise<PrintJobBatchResult> {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return await this.attach(kernel).jobs.enqueueBundle(body, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/jobs/:id/cancel")
  async cancel(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { job: await this.attach(kernel).jobs.cancel(id, ctx) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/jobs/:id/retry")
  async retry(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { job: await this.attach(kernel).jobs.retry(id, ctx) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Get("print/logs")
  async logs(
    @Query("limit") limit?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<{ logs: PrintLogEntry[] }> {
    return this.human.run(authorization, this.kernel, async (kernel) => ({
      logs: await this.attach(kernel).jobs.logs(Number(limit) || 50),
    }));
  }

  @Get("print/templates")
  async templates(
    @Query("kind") kind?: string,
    @Headers("authorization") authorization?: string,
  ): Promise<PrintTemplateList> {
    return this.human.run(authorization, this.kernel, async (kernel) => {
      const parsed = kind ? PrintDocumentKind.safeParse(kind) : null;
      if (kind && !parsed?.success) throw new BadRequestException("未知单据类型");
      return {
        templates: await this.attach(kernel).templates.list(
          parsed?.success ? parsed.data : undefined,
        ),
      };
    });
  }

  @Post("print/templates")
  async publishTemplate(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return { template: await this.attach(kernel).templates.publish(body, ctx) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/templates/:id/versions")
  async publishVersion(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), templateId: id };
        return { template: await this.attach(kernel).templates.publishVersion(input, ctx) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Get("print/devices")
  async devices(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) =>
      this.attach(kernel).devices.list(),
    );
  }

  @Post("print/devices/agents")
  async registerAgent(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        return await this.attach(kernel).devices.register(body, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/devices/agents/:id/disable")
  async disableAgent(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        await this.attach(kernel).devices.disable(id, ctx);
        return { ok: true };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Get("shipping/pending")
  async pending(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) => ({
      orders: await this.attach(kernel).views.listPendingShipping(20),
    }));
  }

  @Post("orders/:id/shipments")
  async createShipment(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), orderId: id };
        const shipment = await kernel.orderShipments.create(CreateShipmentInput.parse(input), ctx);
        return { shipment, view: await this.attach(kernel).views.getShipmentView(shipment.id) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Get("orders/:id/shipments")
  async listShipments(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) => ({
      shipments: await kernel.orderShipments.listByOrder(id),
    }));
  }

  @Get("shipments/:id")
  async shipment(
    @Param("id") id: string,
    @Headers("authorization") authorization?: string,
  ): Promise<ShipmentView> {
    return this.human.run(authorization, this.kernel, async (kernel) => {
      try {
        return await this.attach(kernel).views.getShipmentView(id);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("shipments/:id/ship")
  async ship(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const print = this.attach(kernel);
        const view = await print.views.getShipmentView(id);
        if (view.printBlockedReason === "DISCREPANCY") {
          throw new Error("箱唛与明细不一致，先核对差异");
        }
        if (view.printBlockedReason === "QUANTITY_MISMATCH") {
          throw new Error("箱内数量与发货数量不一致，先核对差异");
        }
        const shipment = await kernel.orderShipments.markShipped(id, ctx);
        return { shipment, view: await print.views.getShipmentView(id) };
      } catch (error) {
        if (isKernelError(error)) rethrowPrint(error);
        throw new BadRequestException(error instanceof Error ? error.message : "确认发货失败");
      }
    });
  }

  @Post("shipments/:id/boxes")
  async createBoxes(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), shipmentId: id };
        return await this.attach(kernel).jobs.createBoxes(input, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("shipments/:id/pick-scan")
  async pickScan(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), shipmentId: id };
        return await this.attach(kernel).jobs.pickScan(input, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("shipments/:id/verify-scan")
  async verifyScan(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const input = { ...(body as Record<string, unknown>), shipmentId: id };
        return await this.attach(kernel).jobs.verifyScan(input, ctx);
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/boxes/:id/reprint")
  async reprintBox(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const parsed = body as { reason?: string; copies?: number; printerId?: string | null };
        const reason = ReprintReason.safeParse(parsed.reason);
        if (!reason.success) {
          throw new BadRequestException({
            error: { code: "PRINT_REPRINT_REASON_REQUIRED", message: "补打必须选择原因" },
          });
        }
        const result = await this.attach(kernel).jobs.reprintBox(
          id,
          {
            reason: reason.data,
            ...(parsed.copies ? { copies: parsed.copies } : {}),
            ...(parsed.printerId ? { printerId: parsed.printerId } : {}),
          },
          ctx,
        );
        return result;
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/boxes/:id/void")
  async voidBox(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const reason =
          typeof (body as { reason?: unknown }).reason === "string"
            ? (body as { reason: string }).reason
            : "人工作废";
        return { shipment: await this.attach(kernel).jobs.voidBox(id, reason, ctx) };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }

  @Post("print/boxes/:id/resolve-discrepancy")
  async resolveDiscrepancy(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => {
      try {
        const note =
          typeof (body as { note?: unknown }).note === "string"
            ? (body as { note: string }).note
            : "";
        return {
          shipment: await this.attach(kernel).jobs.resolveDiscrepancy(id, note, ctx),
        };
      } catch (error) {
        rethrowPrint(error);
      }
    });
  }
}

/**
 * 打印代理 HTTP 面（token 只能打印，不能读业务数据）。
 * 不挂 HUMAN_ACTOR，也不暴露任何 /customers /orders 读写。
 */
@Controller("api/print/agent")
export class PrintAgentController {
  constructor(@Inject(PrintAgentAuthService) private readonly auth: PrintAgentAuthService) {}

  private bearer(authorization: string | undefined): string {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match?.[1]) throw new UnauthorizedException("缺少打印代理 token");
    return match[1];
  }

  @Get("me")
  async me(@Headers("authorization") authorization?: string) {
    return this.withAgent(authorization, (db, identity) =>
      new PrintDeviceService(db, identity.tenantId).getAgent(identity.agentId),
    );
  }

  @Post("heartbeat")
  async heartbeat(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.withAgent(authorization, (db, identity) =>
      new PrintDeviceService(db, identity.tenantId).heartbeat(identity.agentId, body),
    );
  }

  @Post("claim")
  async claim(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.withAgent(authorization, async (db, identity) => {
      const limit =
        typeof (body as { limit?: unknown }).limit === "number"
          ? (body as { limit: number }).limit
          : 5;
      const jobs = printJobsFor(db, identity.tenantId);
      return { jobs: await jobs.claim(identity.agentId, Math.min(Math.max(limit, 1), 20)) };
    });
  }

  @Post("result")
  async result(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.withAgent(authorization, async (db, identity) => {
      const jobs = printJobsFor(db, identity.tenantId);
      return { job: await jobs.report(identity.agentId, body) };
    });
  }

  private async withAgent<T>(
    authorization: string | undefined,
    fn: (db: AgentDb, identity: AgentIdentity) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.auth.withToken(this.bearer(authorization), fn);
    } catch (error) {
      rethrowPrint(error);
    }
  }
}
