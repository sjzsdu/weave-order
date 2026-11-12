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
  Post,
  Query,
} from "@nestjs/common";
import { QuoteLinkError as QuoteLinkErrorContract } from "@weave-order/schema";
import type { QuoteLinkErrorCode } from "@weave-order/schema";
import { QuoteLinkError } from "../kernel";
import type { Kernel } from "../kernel";
import { HUMAN_CONTEXT } from "./context";
import { KERNEL, PUBLIC_SHARE } from "./tokens";
import type { PublicShareService } from "../shares/public-share.service";
import type { ShareVisitor } from "../kernel/shares.service";

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

function visitor(ip: string | undefined, forwarded: string | undefined, ua: string | undefined) {
  const realIp = forwarded?.split(",")[0]?.trim() || ip;
  return { ip: realIp, userAgent: ua } satisfies ShareVisitor;
}

/**
 * 客户报价链接的公开路由（无登录、无鉴权 Cookie）。
 *
 * 只返回 `CustomerQuoteView` 允许的字段；所有写操作只有三类事件：
 * 查看 / 提问 / 接受（接受 ≠ 合同，不改报价账本）。
 */
@Controller("api/public/quotes")
export class PublicQuoteController {
  constructor(@Inject(PUBLIC_SHARE) private readonly shares: PublicShareService) {}

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
  constructor(@Inject(KERNEL) private readonly kernel: Kernel) {}

  /** T0 冻结契约（移动端）：quoteId 在 body，返回裸 CreatedQuoteShare。 */
  @Post("quote-shares")
  async createLegacy(@Body() body: unknown) {
    return this.kernel.shares.createFromInput(body, HUMAN_CONTEXT);
  }

  /** T0 冻结契约（移动端）：客户 360 的链接访问时间线。 */
  @Get("quote-shares")
  async listLegacy(@Query("quoteId") quoteId?: string) {
    return this.kernel.shares.listLegacy(quoteId);
  }

  @Post("quotes/:id/shares")
  async create(@Param("id") quoteId: string, @Body() body: unknown) {
    return {
      ok: true,
      data: await this.kernel.shares.createForQuote(quoteId, body ?? {}, HUMAN_CONTEXT),
    };
  }

  @Get("quotes/:id/shares")
  async list(@Param("id") quoteId: string) {
    return { ok: true, data: await this.kernel.shares.listForQuote(quoteId) };
  }

  @Post("shares/:id/revoke")
  async revoke(@Param("id") shareId: string) {
    return { ok: true, data: await this.kernel.shares.revoke(shareId, HUMAN_CONTEXT) };
  }
}
