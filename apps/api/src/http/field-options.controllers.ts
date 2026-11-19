import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { FieldKey, FieldOptionListResponse, ResolveFieldValueResponse } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

function parseField(raw: string | undefined): FieldKey {
  const parsed = FieldKey.safeParse(raw);
  if (!parsed.success) throw new BadRequestException(`未知字段：${raw ?? "(空)"}`);
  return parsed.data;
}

/**
 * 字段选项 HTTP 面（WAN-178）。
 *
 * 读接口（列表/解析）所有 ACTIVE 成员可用，写接口由内核校验 `field_options.manage`。
 * 权限判断不在这里复制一份：调用点只负责把 role 交给内核，规则只在 capabilities.ts。
 */
@Controller("api/field-options")
export class FieldOptionsController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get()
  async list(
    @Query("field") field: string | undefined,
    @Query("includeInactive") includeInactive: string | undefined,
    @Query("usage") usage: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    const fieldKey = parseField(field);
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel) => {
        if (usage === "1" || usage === "true") {
          return FieldOptionListResponse.parse({
            options: await kernel.fieldOptions.listWithUsage(fieldKey),
          });
        }
        // 停用选项仍要下发：历史客户/样品的 label 要靠它解析，删掉会让旧数据显示原始 code。
        const options = await kernel.fieldOptions.list(
          fieldKey,
          includeInactive !== "0" && includeInactive !== "false",
        );
        return FieldOptionListResponse.parse({
          options: options.map((option) => ({ ...option, usage: 0 })),
        });
      },
      { scope: "read" },
    );
  }

  /** 智能体/导入共用：只做归一化精确匹配，未命中返回 matched=false。 */
  @Get("resolve")
  async resolve(
    @Query("field") field: string | undefined,
    @Query("value") value: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    const fieldKey = parseField(field);
    if (!value || !value.trim()) throw new BadRequestException("value 不能为空");
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel) => {
        const resolved = await kernel.fieldOptions.resolve(fieldKey, value, true);
        return ResolveFieldValueResponse.parse({
          ...resolved,
          input: resolved.input,
        });
      },
      { scope: "read" },
    );
  }

  /** 幂等创建：同名（归一化后）返回已有选项，并发也落到同一行。 */
  @Post()
  async create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({
          option: await kernel.fieldOptions.create(body, ctx),
        }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Patch(":id")
  async rename(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({
          option: await kernel.fieldOptions.rename(id, body, ctx),
        }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          await kernel.fieldOptions.remove(id, ctx);
          return { ok: true };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post(":id/restore")
  async restore(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({
          option: await kernel.fieldOptions.restore(id, ctx),
        }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("reorder")
  async reorder(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) =>
          FieldOptionListResponse.parse({
            options: (await kernel.fieldOptions.reorder(body, ctx)).map((option) => ({
              ...option,
              usage: 0,
            })),
          }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("merge/preview")
  async previewMerge(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const parsed = parseMergeBody(body);
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel) => kernel.fieldOptions.previewMerge(parsed.sourceId, parsed.targetId),
      { scope: "read" },
    );
  }

  @Post("merge")
  async merge(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.fieldOptions.merge(body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}

function parseMergeBody(body: unknown): { sourceId: string; targetId: string } {
  const sourceId = (body as { sourceId?: unknown })?.sourceId;
  const targetId = (body as { targetId?: unknown })?.targetId;
  if (typeof sourceId !== "string" || typeof targetId !== "string") {
    throw new BadRequestException("sourceId 与 targetId 必填");
  }
  return { sourceId, targetId };
}
