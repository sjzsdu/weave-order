import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/decorators";
import { loadEnv } from "../env";
import { TenantsService } from "../control/tenants.service";

const RegisterTrialInput = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(255),
    ownerEmail: z.string().email().nullable().optional(),
  })
  .strict();

/**
 * 租户端 → 控制面的内部接口：老板自助开通后，登记一条试用订阅。
 *
 * 为什么放在控制面：业务库不允许写账单，控制面不允许读业务数据。
 * 两边只交换「公司标识、公司名、联系人邮箱」，不涉及任何客户与报价。
 *
 * 鉴权用与开通链接同一把共享密钥（`ONBOARDING_SECRET`），不走平台 OIDC：
 * 这条调用来自服务进程，不是人。密钥不一致直接 401。
 */
@Controller("platform/api/internal")
export class InternalController {
  constructor(@Inject(TenantsService) private readonly tenants: TenantsService) {}

  @Post("tenants")
  @Public()
  async register(
    @Headers("x-weave-internal") token: string | undefined,
    @Body() body: unknown,
  ): Promise<{ tenantId: string; slug: string; created: boolean }> {
    const env = loadEnv();
    if (!token || token !== env.ONBOARDING_SECRET) {
      throw new HttpException(
        { error: { code: "UNAUTHENTICATED", message: "内部调用凭据不正确" } },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const parsed = RegisterTrialInput.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: { code: "INVALID_INPUT", message: "参数不合法" } },
        HttpStatus.BAD_REQUEST,
      );
    }
    return await this.tenants.registerTrialTenant(parsed.data);
  }
}
