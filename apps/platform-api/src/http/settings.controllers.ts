import {
  BadRequestException,
  Inject,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  FeatureFlagInput,
  PlatformConfigInput,
  PlatformLlmSettingsInput,
} from "@weave-order/schema";
import { AuthService } from "../auth/auth.service";
import type { PlatformActor, PlatformRequest } from "../auth/auth.service";
import { Public, RequirePermission } from "../auth/decorators";
import { forbidden, invalid } from "../domain/errors";
import { ApprovalsService } from "../control/approvals.service";
import { AuditService } from "../control/audit.service";
import { BreakGlassService } from "../control/break-glass.service";
import { PricingService } from "../control/pricing.service";
import { SettingsService } from "../control/settings.service";
import { SupportService } from "../control/support.service";
import { UsageService } from "../control/usage.service";
import { loadEnv } from "../env";

function actorOf(request: PlatformRequest): PlatformActor {
  if (!request.platformActor) throw new Error("guard 未注入平台身份");
  return request.platformActor;
}

@Controller("platform/api/usage")
export class UsageController {
  private readonly env = loadEnv();

  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * 用量事件入口：租户侧 billing 内核用服务密钥调用；平台运维也可手动补录。
   * 幂等键唯一，重放返回 inserted=false。
   */
  @Post("events")
  @Public()
  async ingest(
    @Headers("x-ingest-key") ingestKey: string | undefined,
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const key = this.env.PLATFORM_INGEST_KEY;
    if (key && ingestKey === key) return this.usage.ingest(body);
    if (!authorization) throw forbidden("缺少平台令牌或 x-ingest-key");
    const actor = await this.auth.authenticate(authorization);
    if (!actor.permissions.includes("usage:write")) throw forbidden("缺少 usage:write 权限");
    return this.usage.ingest(body);
  }
}

@Controller("platform/api/pricing")
export class PricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get("plans")
  @RequirePermission("pricing:read")
  async plans() {
    return { plans: await this.pricing.listPlans() };
  }

  /** 空控制面自助初始化：没有默认套餐时，owner/finance 可以直接建。 */
  @Post("plans")
  @RequirePermission("pricing:write")
  async createPlan(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { plan: await this.pricing.createPlan(actorOf(request), body) };
  }

  @Get("books")
  @RequirePermission("pricing:read")
  async books() {
    return { books: await this.pricing.listBooks() };
  }

  @Get("books/:id")
  @RequirePermission("pricing:read")
  book(@Param("id") id: string) {
    return this.pricing.getBook(id);
  }

  @Get("books/:id/impact")
  @RequirePermission("pricing:read")
  impact(@Param("id") id: string) {
    return this.pricing.impact(id);
  }

  @Post("books")
  @RequirePermission("pricing:write")
  async createBook(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { book: await this.pricing.createBook(actorOf(request), body) };
  }

  /** 改价永远先创建 owner+finance 双人复核，不直接生效。 */
  @Post("books/:id/activate-request")
  @RequirePermission("pricing:write")
  async activate(@Req() request: PlatformRequest, @Param("id") id: string) {
    const actor = actorOf(request);
    const detail = await this.pricing.getBook(id);
    if (detail.book.status === "ACTIVE") throw invalid("该价格版本已经生效");
    const reason = "价格表生效（改价需 owner + finance 双人复核）";
    const approval = await this.approvals.create(actor, {
      action: "PRICE_CHANGE",
      targetType: "price_book",
      targetId: id,
      summary: `价格表 v${detail.book.version} 生效`,
      payload: { priceBookId: id, reason },
      reason,
    });
    return { approval };
  }

  @Get("overrides")
  @RequirePermission("pricing:read")
  async overrides(@Query("tenantId") tenantId?: string) {
    return { overrides: await this.pricing.listOverrides(tenantId) };
  }

  @Post("preview")
  @RequirePermission("pricing:read")
  preview(@Body() body: unknown) {
    return this.pricing.preview(body);
  }
}

@Controller("platform/api/settings/llm")
export class LlmSettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("settings:read")
  get() {
    return this.settings.getLlm();
  }

  @Put()
  @RequirePermission("llm:write")
  async upsert(@Req() request: PlatformRequest, @Body() body: unknown) {
    PlatformLlmSettingsInput.parse(body);
    return { settings: await this.settings.upsertLlm(actorOf(request), body) };
  }

  /**
   * 连通性测试会带真实密钥出网，且目标地址/密钥引用来自请求体：
   * 权限从 `settings:read` 提升到 `llm:write`（platform_readonly 不再可调），并强制走服务层审计。
   */
  @Post("test")
  @RequirePermission("llm:write")
  async test(@Req() request: PlatformRequest, @Body() body: { baseUrl?: string; keyRef?: string }) {
    return this.settings.testLlm(actorOf(request), body ?? {});
  }

  @Get("stats")
  @RequirePermission("usage:read")
  stats() {
    return this.settings.llmStats();
  }
}

@Controller("platform/api/settings/feature-flags")
export class FeatureFlagsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("settings:read")
  async list() {
    return { flags: await this.settings.listFlags() };
  }

  @Post()
  @RequirePermission("flag:write")
  async create(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { flag: await this.settings.createFlag(actorOf(request), body) };
  }

  @Patch(":key")
  @RequirePermission("flag:write")
  async update(@Req() request: PlatformRequest, @Param("key") key: string, @Body() body: unknown) {
    FeatureFlagInput.parse(body);
    return { flag: await this.settings.updateFlag(actorOf(request), key, body) };
  }
}

@Controller("platform/api/settings/configs")
export class ConfigsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("settings:read")
  async list() {
    return { configs: await this.settings.listConfigs() };
  }

  @Get("history")
  @RequirePermission("settings:read")
  async history(@Query("key") key: string) {
    if (!key) throw new BadRequestException("缺少 key");
    return { versions: await this.settings.configHistory(key) };
  }

  @Post("preview")
  @RequirePermission("config:write")
  preview(@Body() body: unknown) {
    PlatformConfigInput.parse(body);
    return this.settings.configPreview(body);
  }

  @Post()
  @RequirePermission("config:write")
  async save(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { config: await this.settings.saveConfig(actorOf(request), body) };
  }

  @Post(":id/rollback")
  @RequirePermission("config:write")
  async rollback(@Req() request: PlatformRequest, @Param("id") id: string) {
    return { config: await this.settings.rollbackConfig(actorOf(request), id) };
  }
}

@Controller("platform/api/settings/identity")
export class IdentityController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission("settings:read")
  get() {
    return this.settings.getIdentity();
  }

  @Patch()
  @RequirePermission("identity:write")
  async update(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { settings: await this.settings.updateIdentity(actorOf(request), body) };
  }
}

@Controller("platform/api/approvals")
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermission("approval:read")
  async list(@Query("status") status?: string) {
    return { approvals: await this.approvals.list(status) };
  }

  @Get(":id")
  @RequirePermission("approval:read")
  get(@Param("id") id: string) {
    return this.approvals.get(id);
  }

  @Post(":id/decide")
  @RequirePermission("approval:decide")
  async decide(@Req() request: PlatformRequest, @Param("id") id: string, @Body() body: unknown) {
    return { approval: await this.approvals.decide(actorOf(request), id, body) };
  }
}

@Controller("platform/api/audit")
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit:read")
  async list(
    @Query("limit") limit?: string,
    @Query("action") action?: string,
    @Query("targetId") targetId?: string,
  ) {
    const parsed = Number(limit);
    const safeLimit = Number.isFinite(parsed) ? parsed : 100;
    return { entries: await this.audit.list(safeLimit, { action, targetId }) };
  }
}

@Controller("platform/api/break-glass")
export class BreakGlassController {
  constructor(
    @Inject(BreakGlassService) private readonly breakGlass: BreakGlassService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission("support:read")
  async list() {
    return { requests: await this.breakGlass.list() };
  }

  @Get(":id")
  @RequirePermission("support:read")
  get(@Param("id") id: string) {
    return this.breakGlass.get(id);
  }

  @Post()
  @RequirePermission("breakglass:request")
  async create(@Req() request: PlatformRequest, @Body() body: unknown) {
    const actor = actorOf(request);
    const created = await this.breakGlass.create(actor, body);
    const approval = await this.approvals.create(actor, {
      action: "BREAK_GLASS",
      targetType: "break_glass",
      targetId: created.id,
      summary: `Break-glass：${created.tenantName}（${created.ticketNo}，≤60 分钟只读）`,
      payload: { breakGlassId: created.id },
      reason: created.reason,
    });
    return { request: created, approval };
  }

  @Post(":id/access")
  @RequirePermission("breakglass:request")
  async access(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: { resource?: string },
  ) {
    return this.breakGlass.recordAccess(actorOf(request), id, body.resource ?? "unspecified");
  }

  @Post(":id/reject")
  @RequirePermission("breakglass:approve")
  async reject(
    @Req() request: PlatformRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    return this.breakGlass.reject(actorOf(request), id, body.reason ?? "拒绝");
  }
}

@Controller("platform/api/support/tickets")
export class SupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get()
  @RequirePermission("support:read")
  async list() {
    return { tickets: await this.support.list() };
  }

  @Post()
  @RequirePermission("support:write")
  async create(@Req() request: PlatformRequest, @Body() body: unknown) {
    return { ticket: await this.support.create(actorOf(request), body) };
  }

  @Patch(":id/status")
  @RequirePermission("support:write")
  async status(@Req() request: PlatformRequest, @Param("id") id: string, @Body() body: unknown) {
    return { ticket: await this.support.updateStatus(actorOf(request), id, body) };
  }
}
