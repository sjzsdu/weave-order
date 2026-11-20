import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { QuoteLinkError as QuoteLinkErrorContract } from "@weave-order/schema";
import type { QuoteLinkErrorCode } from "@weave-order/schema";
import { QuoteLinkError } from "../kernel";
import type { Kernel } from "../kernel";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL, PUBLIC_RATE_LIMIT, PUBLIC_SHARE } from "./tokens";
import type { PublicShareService } from "../shares/public-share.service";
import type { ShareVisitor } from "../kernel/shares.service";
import { PublicRateLimitService } from "../platform/rate-limit";

const STATUS_BY_CODE: Record<QuoteLinkErrorCode, number> = {
  INVALID_LINK: HttpStatus.NOT_FOUND,
  INVALID_INPUT: HttpStatus.BAD_REQUEST,
  EXPIRED: HttpStatus.GONE,
  REVOKED: HttpStatus.GONE,
  PHONE_TAIL_REQUIRED: HttpStatus.BAD_REQUEST,
  PHONE_TAIL_MISMATCH: HttpStatus.BAD_REQUEST,
  PDF_DISABLED: HttpStatus.FORBIDDEN,
};

function isZodLike(error: unknown): error is { issues: unknown[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown[] }).issues)
  );
}

/** 把客户侧错误收敛成契约里封闭的 `QuoteLinkError`，不泄露内部实现。 */
function linkFailure(error: unknown): never {
  if (error instanceof QuoteLinkError) {
    throw new HttpException(
      QuoteLinkErrorContract.parse({
        ok: false,
        error: { code: error.code, message: error.message },
      }),
      STATUS_BY_CODE[error.code],
    );
  }
  if (isZodLike(error)) {
    throw new HttpException(
      QuoteLinkErrorContract.parse({
        ok: false,
        error: { code: "INVALID_INPUT", message: "请求格式不正确，请检查后重试" },
      }),
      HttpStatus.BAD_REQUEST,
    );
  }
  throw error;
}

function clientIp(ip: string | undefined, forwarded: string | undefined): string | undefined {
  return forwarded?.split(",")[0]?.trim() || ip;
}

function visitor(ip: string | undefined, forwarded: string | undefined, ua: string | undefined) {
  return { ip: clientIp(ip, forwarded), userAgent: ua } satisfies ShareVisitor;
}

/**
 * 客户报价链接的公开路由（无登录、无鉴权 Cookie）。
 *
 * 只返回 `CustomerQuoteView` 允许的字段；所有写操作只有三类事件：
 * 查看 / 提问 / 接受（接受 ≠ 合同，不改报价账本）。
 */
@Controller("api/public/quotes")
export class PublicQuoteController {
  constructor(
    @Inject(PUBLIC_SHARE) private readonly shares: PublicShareService,
    @Inject(PUBLIC_RATE_LIMIT) private readonly limits: PublicRateLimitService,
  ) {}

  /**
   * IP + token 双维度限流；超限直接 429，不进入租户会话（不占用连接池）。
   * 阈值见 `platform/rate-limit.ts` 的 `PUBLIC_QUOTE_RATE_LIMITS`。
   */
  private async enforce(
    action: "view" | "accept" | "questions" | "pdf",
    token: string,
    ip: string | undefined,
    forwarded: string | undefined,
  ): Promise<void> {
    const denial = await this.limits.check(action, clientIp(ip, forwarded), token);
    if (!denial) return;
    throw new HttpException(
      {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "请求过于频繁，请稍后再试",
          retryAfterSeconds: denial.retryAfterSeconds,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  @Get(":token")
  @Header("Cache-Control", "no-store")
  @Header("X-Robots-Tag", "noindex, nofollow")
  async view(
    @Param("token") token: string,
    @Query("track") track: string | undefined,
    @Ip() ip: string | undefined,
    @Headers("x-forwarded-for") forwarded: string | undefined,
    @Headers("user-agent") ua: string | undefined,
  ) {
    await this.enforce("view", token, ip, forwarded);
    try {
      const data = await this.shares.view(token, visitor(ip, forwarded, ua), {
        track: track !== "0",
      });
      return { ok: true, data };
    } catch (error) {
      return linkFailure(error);
    }
  }

  @Post(":token/accept")
  @Header("Cache-Control", "no-store")
  async accept(
    @Param("token") token: string,
    @Body() body: unknown,
    @Ip() ip: string | undefined,
    @Headers("x-forwarded-for") forwarded: string | undefined,
    @Headers("user-agent") ua: string | undefined,
  ) {
    await this.enforce("accept", token, ip, forwarded);
    try {
      const data = await this.shares.accept(token, body ?? {}, visitor(ip, forwarded, ua));
      return { ok: true, data };
    } catch (error) {
      return linkFailure(error);
    }
  }

  @Post(":token/questions")
  @Header("Cache-Control", "no-store")
  async ask(
    @Param("token") token: string,
    @Body() body: unknown,
    @Ip() ip: string | undefined,
    @Headers("x-forwarded-for") forwarded: string | undefined,
    @Headers("user-agent") ua: string | undefined,
  ) {
    await this.enforce("questions", token, ip, forwarded);
    try {
      const data = await this.shares.ask(token, body ?? {}, visitor(ip, forwarded, ua));
      return { ok: true, data };
    } catch (error) {
      return linkFailure(error);
    }
  }

  @Post(":token/pdf")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header("Cache-Control", "no-store")
  async pdf(
    @Param("token") token: string,
    @Ip() ip: string | undefined,
    @Headers("x-forwarded-for") forwarded: string | undefined,
    @Headers("user-agent") ua: string | undefined,
  ) {
    await this.enforce("pdf", token, ip, forwarded);
    try {
      await this.shares.recordPdf(token, visitor(ip, forwarded, ua));
      return;
    } catch (error) {
      return linkFailure(error);
    }
  }
}

/**
 * 业务员侧：生成 / 查看 / 撤回报价链接与访问数据。
 * 与审批窗口同为 HUMAN 上下文；草稿不能生成链接。
 */
@Controller("api")
export class QuoteSharesController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  /** T0 冻结契约（移动端）：quoteId 在 body，返回裸 CreatedQuoteShare。 */
  @Post("quote-shares")
  async createLegacy(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, (kernel, ctx) =>
      kernel.shares.createFromInput(body, ctx),
    );
  }

  /** T0 冻结契约（移动端）：客户 360 的链接访问时间线。 */
  @Get("quote-shares")
  async listLegacy(
    @Query("quoteId") quoteId: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, (kernel) =>
      kernel.shares.listLegacy(quoteId),
    );
  }

  @Post("quotes/:id/shares")
  async create(
    @Param("id") quoteId: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.createForQuote(quoteId, body ?? {}, ctx),
    }));
  }

  @Get("quotes/:id/shares")
  async list(@Param("id") quoteId: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel) => ({
      ok: true,
      data: await kernel.shares.listForQuote(quoteId),
    }));
  }

  @Post("shares/:id/revoke")
  async revoke(@Param("id") shareId: string, @Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.revoke(shareId, ctx),
    }));
  }

  /**
   * 租户级公开面开关。关闭后已生成的链接立即失效（公开路由按 INVALID_LINK 返回），
   * 同时不允许再生成新链接；业务员仍可查看/撤回存量链接。
   */
  @Get("settings/quote-sharing")
  async getSharingSettings(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.getSharingSettings(ctx),
    }));
  }

  /** 样卡与客户报价页共用的业务员联系方式。 */
  @Get("settings/sales-contact")
  async getSalesContact(@Headers("authorization") authorization?: string) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.getSalesContact(ctx),
    }));
  }

  @Patch("settings/sales-contact")
  async updateSalesContact(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.updateSalesContact(body ?? {}, ctx),
    }));
  }

  @Patch("settings/quote-sharing")
  async updateSharingSettings(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    return this.human.run(authorization, this.kernel, async (kernel, ctx) => ({
      ok: true,
      data: await kernel.shares.updateSharingSettings(body ?? {}, ctx),
    }));
  }
}
