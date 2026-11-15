import { Controller, Get, Headers, Inject, NotFoundException, Param } from "@nestjs/common";
import { DemoSceneListResponse, DemoSceneResponse, demoSceneByKey } from "@weave-order/schema";
import type { ApprovalItem } from "@weave-order/schema";
import { ResolvedDemoScene } from "@weave-order/schema";
import { createApprovalService } from "../approval";
import { HUMAN_ACTOR, KERNEL } from "../http/tokens";
import { HumanActorService } from "../http/human-actor.service";
import type { Kernel, KernelContext } from "../kernel";
import { loadDemoScenes, resolveSceneFromQueue } from "./scene-catalog";

/** 在租户 + 数据范围内把「客户编号 + 单据类型」解析成审批队列里的真实 id。 */
async function resolveScene(
  kernel: Kernel,
  ctx: KernelContext,
  key: string,
): Promise<ResolvedDemoScene> {
  const scenes = loadDemoScenes();
  const scene = demoSceneByKey(scenes, key);
  if (!scene) {
    throw new NotFoundException({
      error: { code: "NOT_FOUND", message: `未知剧本：${key}` },
    });
  }
  const customers = await kernel.customers.list(
    { query: scene.anchor.customerCode, limit: 1 },
    ctx,
  );
  const customerId = customers.find((item) => item.code === scene.anchor.customerCode)?.id ?? null;
  const queue = await createApprovalService(kernel).listPending(ctx, { limit: 100 });
  const items: ApprovalItem[] = queue.items;
  const { entityId } = resolveSceneFromQueue(scene, customerId, items);
  return ResolvedDemoScene.parse({ ...scene, entityId, resolved: entityId !== null });
}

@Controller("api/demo")
export class DemoScenesController {
  constructor(
    @Inject(KERNEL) private readonly kernel: Kernel,
    @Inject(HUMAN_ACTOR) private readonly human: HumanActorService,
  ) {}

  /** 剧本清单：前端身份条 / 演示入口一次拿全，避免逐个请求。 */
  @Get("scenes")
  async list(@Headers("authorization") authorization?: string) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        const scenes = [];
        for (const scene of loadDemoScenes()) {
          scenes.push(await resolveScene(kernel, ctx, scene.key));
        }
        return DemoSceneListResponse.parse({ scenes });
      },
      { scope: "read" },
    );
  }

  /** 单条剧本：深链 `?scene=<key>` 只取这一条。 */
  @Get("scenes/:key")
  async get(@Param("key") key: string, @Headers("authorization") authorization?: string) {
    return this.human.run(
      authorization,
      this.kernel,
      async (kernel, ctx) => {
        return DemoSceneResponse.parse({ scene: await resolveScene(kernel, ctx, key) });
      },
      { scope: "read" },
    );
  }
}
