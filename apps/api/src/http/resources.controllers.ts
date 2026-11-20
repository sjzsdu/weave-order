import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { ResourceFieldsResponse } from "@weave-order/schema";
import type { Kernel } from "../kernel";
import type { KernelContext } from "../kernel";
import { rethrowHttp } from "./controllers";
import type { HumanActorService } from "./human-actor.service";
import { HUMAN_ACTOR, KERNEL } from "./tokens";

/**
 * 资源草稿 / 字段出处 / 合并的 HTTP 面（P0a）。
 *
 * 客户与样品共用同一套骨架：草稿创建 → 逐字段确认 → 确认可用 → 合并。
 * 控制器只做路由与错误映射，不复制状态判断。
 */
@Controller("api")
export class ResourceController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  @Post("customers/draft")
  async createCustomerDraft(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.customers.createDraft(body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("customers/:id/confirm")
  @HttpCode(200)
  async confirmCustomer(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({ customer: await kernel.customers.confirmDraft(id, ctx) }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("customers/:id/merge/preview")
  @HttpCode(200)
  async previewMerge(
    @Param("id") id: string,
    @Body() body: { targetCustomerId?: string },
    @Headers("authorization") authorization?: string,
  ) {
    try {
      if (!body?.targetCustomerId) {
        throw new BadRequestException("缺少 targetCustomerId");
      }
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.customers.previewMerge(id, body.targetCustomerId!, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("customers/:id/merge")
  @HttpCode(200)
  async merge(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.customers.merge(id, body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("customers/:id/merge/undo")
  @HttpCode(200)
  async undoMerge(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.customers.undoMerge(id, body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("customers/:id/fields")
  async customerFields(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => this.fieldsOf(kernel, "customer", id, ctx),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Patch("customers/:id/fields")
  async updateCustomerFields(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const fields = await kernel.resourceFields.updateFields("customer", id, body, ctx);
          return { fields };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("samples/draft")
  async createSampleDraft(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => kernel.samples.createDraft(body, ctx),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Post("samples/:id/confirm")
  @HttpCode(200)
  async confirmSample(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => ({ sample: await kernel.samples.confirmDraft(id, ctx) }),
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Get("samples/:id/fields")
  async sampleFields(@Param("id") id: string, @Headers("authorization") authorization?: string) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => this.fieldsOf(kernel, "sample", id, ctx),
        { scope: "read" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  @Patch("samples/:id/fields")
  async updateSampleFields(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    try {
      return await this.human.run(
        authorization,
        this.kernel,
        async (kernel, ctx) => {
          const fields = await kernel.resourceFields.updateFields("sample", id, body, ctx);
          return { fields };
        },
        { scope: "write" },
      );
    } catch (error) {
      rethrowHttp(error);
    }
  }

  private async fieldsOf(
    kernel: Kernel,
    resourceType: "customer" | "sample",
    resourceId: string,
    ctx?: KernelContext,
  ): Promise<ResourceFieldsResponse> {
    // 资源状态决定「确认可用」按钮是否可用：先读资源再读矩阵。
    const status =
      resourceType === "customer"
        ? (await kernel.customers.getById(resourceId, ctx)).status
        : mapSampleStatus((await kernel.samples.getById(resourceId, ctx?.actor.role)).status);
    const fields = await kernel.resourceFields.list(resourceType, resourceId, status);
    return {
      resourceType,
      resourceId,
      resourceStatus: status,
      fields,
      pendingCount: fields.filter(
        (field) => field.status === "PENDING" || field.status === "CONFLICT",
      ).length,
    };
  }
}

function mapSampleStatus(status: string): "DRAFT" | "AVAILABLE" | "ARCHIVED" {
  if (status === "DRAFT") return "DRAFT";
  if (status === "ARCHIVED") return "ARCHIVED";
  return "AVAILABLE";
}
