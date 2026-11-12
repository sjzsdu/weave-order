import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  StreamableFile,
} from "@nestjs/common";
import { EntityId, ExportQuoteInput } from "@weave-order/schema";
import type { QuoteDetail, QuoteSendList } from "@weave-order/schema";
import type { QuoteExportService } from "../export";
import { isKernelError } from "../kernel";
import { HUMAN_CONTEXT } from "./context";
import { QUOTE_EXPORT } from "./tokens";

/** 路径参数先按契约校验，非法 id 是 400，不该变成数据库 500。 */
function parseQuoteId(raw: string): string {
  const parsed = EntityId.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException({ code: "INVALID_INPUT", message: `报价单 id 不是合法 UUID：${raw}` });
  }
  return parsed.data;
}

function toHttpException(error: unknown): unknown {
  if (!isKernelError(error)) return error;
  const status =
    error.code === "RESOURCE_NOT_FOUND" || error.code === "CUSTOMER_NOT_FOUND"
      ? HttpStatus.NOT_FOUND
      : error.code === "PERMISSION_DENIED"
        ? HttpStatus.FORBIDDEN
        : HttpStatus.CONFLICT;
  return new HttpException(
    { code: error.code, message: error.message, details: error.details },
    status,
  );
}

/**
 * 报价出口的 HTTP 面（阶段一）。
 *
 * 与 `POST /api/approvals/decide` 一样，这里固定传 HUMAN 上下文：导出报价单
 * 并记为「已发送」是人的动作，智能体没有这个端点可调。
 * 三个路由都是「读明细 / 读发送记录 / 导出并记账」，不提供任何改账本的能力。
 */
@Controller("api/quotes")
export class QuoteExportController {
  constructor(@Inject(QUOTE_EXPORT) private readonly exporter: QuoteExportService) {}

  /** 已确认报价的完整明细：不限制状态，确认后依然读得出来。 */
  @Get(":id")
  async detail(@Param("id") id: string): Promise<QuoteDetail> {
    try {
      return await this.exporter.detail(parseQuoteId(id));
    } catch (error) {
      throw toHttpException(error);
    }
  }

  /** 发送记录（最新在前）。空数组 = 这份报价从未导出/发送过。 */
  @Get(":id/exports")
  async list(@Param("id") id: string): Promise<QuoteSendList> {
    try {
      return { sends: await this.exporter.listSends(parseQuoteId(id)) };
    } catch (error) {
      throw toHttpException(error);
    }
  }

  /** 导出 PDF 并写一条发送记录；响应体就是文件本身。 */
  @Post(":id/exports")
  @HttpCode(HttpStatus.OK)
  async export(@Param("id") id: string, @Body() body: unknown): Promise<StreamableFile> {
    const parsed = ExportQuoteInput.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: "INVALID_INPUT",
        message: "导出参数不合法",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    try {
      const result = await this.exporter.exportQuote(parseQuoteId(id), HUMAN_CONTEXT, parsed.data);
      return new StreamableFile(Buffer.from(result.bytes), {
        type: "application/pdf",
        disposition: `attachment; filename="${result.filename}"`,
        length: result.bytes.byteLength,
      });
    } catch (error) {
      throw toHttpException(error);
    }
  }
}
