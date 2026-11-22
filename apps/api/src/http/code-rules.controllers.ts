import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  CODE_RULE_PRESETS,
  CodeEntityType,
  CodeRuleListResponse,
  CodeRulePreviewInput,
  SaveCodeRuleInput,
} from "@weave-order/schema";
import type { Kernel } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

function parseEntity(raw: string | undefined): CodeEntityType {
  const parsed = CodeEntityType.safeParse(raw);
  if (!parsed.success) throw new BadRequestException(`未知实体类型：${raw ?? "(空)"}`);
  return parsed.data;
}

/**
 * 编号规则 HTTP 面。
 *
 * 读接口（列表 / 预览）所有 ACTIVE 成员可用；写接口由内核校验 `settings.edit`
 * （权限规则只在 capabilities.ts，这里不复制）。
 */
@Controller("api/code-rules")
export class CodeRulesController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Get()
  async list(@Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel) =>
          CodeRuleListResponse.parse({
            rules: await kernel.codeNumber.list(),
            presets: CODE_RULE_PRESETS.map((preset) => ({
              key: preset.key,
              name: preset.name,
              templates: preset.templates,
            })),
          }),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  /** 预览不写库、不占号：只渲染示例 + 宽度校验。 */
  @Get("preview")
  async preview(
    @Query("entityType") entityType: string | undefined,
    @Query("template") template: string | undefined,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = CodeRulePreviewInput.safeParse({
      entityType: parseEntity(entityType),
      template: template ?? "",
    });
    if (!parsed.success) throw new BadRequestException("entityType 与 template 不能为空");
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        (kernel) => Promise.resolve(kernel.codeNumber.preview(parsed.data.entityType, parsed.data.template)),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Put(":entityType")
  async save(
    @Param("entityType") entityType: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const parsed = SaveCodeRuleInput.safeParse(
      typeof body === "object" && body !== null ? { ...body, entityType: parseEntity(entityType) } : body,
    );
    if (!parsed.success) throw new BadRequestException("编号规则输入不合法");
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({ rule: await kernel.codeNumber.save(parsed.data, ctx) }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post(":entityType/reset")
  async reset(
    @Param("entityType") entityType: string,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({ rule: await kernel.codeNumber.reset(parseEntity(entityType), ctx) }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }
}
