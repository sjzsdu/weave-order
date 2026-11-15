import { z } from "zod";
import { ApprovalKind } from "./approval";

/**
 * 演示剧本（`data/demo-scenes.json`）的契约。
 *
 * 一份剧本被三处消费：销售按它给客户演示、e2e 按它定位固定单据、服务端按它把
 * 深链解析成当前库里的真实单据 id。**不要在别处再抄一份场景清单**。
 *
 * 剧本不存绝对 id：重置后自增 uuid 会变，存 id 的剧本第二次演示就 404。
 * 剧本存「稳定的业务锚点」（客户编号 + 单据类型），服务端每次按锚点查当前 id，
 * 因此 `demo:reset` 前后同一条深链永远落到同一张演示单据。
 */
export const DemoSceneAnchor = z
  .object({
    /** 锚定的单据类型。目前审批中心只聚合这两类。 */
    kind: ApprovalKind,
    /** 演示客户的稳定编号（seed 保证存在且唯一）。 */
    customerCode: z.string().min(1).max(64),
  })
  .strict();
export type DemoSceneAnchor = z.infer<typeof DemoSceneAnchor>;

export const DemoScene = z
  .object({
    key: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(500),
    /** 销售直接发给客户的深链；前端据此高亮。 */
    href: z.string().min(1).max(200),
    anchor: DemoSceneAnchor,
    /** 前端高亮目标；`none` 表示只做场景提示，不高亮列表项。 */
    highlight: z.enum(["approval", "none"]).default("approval"),
  })
  .strict();
export type DemoScene = z.infer<typeof DemoScene>;

/** 同一份文件给脚本 / e2e / 服务端解析器用，入口统一做一次严格校验。 */
export const DemoSceneFile = z
  .object({
    version: z.literal(1),
    scenes: z.array(DemoScene).min(1),
  })
  .strict();
export type DemoSceneFile = z.infer<typeof DemoSceneFile>;

/** 服务端解析后的剧本：附带当前库里真实单据 id（找不到时为空，前端给出「先重置」提示）。 */
export const ResolvedDemoScene = DemoScene.extend({
  entityId: z.string().uuid().nullable(),
  resolved: z.boolean(),
}).strict();
export type ResolvedDemoScene = z.infer<typeof ResolvedDemoScene>;

export const DemoSceneListResponse = z.object({ scenes: z.array(ResolvedDemoScene) }).strict();
export type DemoSceneListResponse = z.infer<typeof DemoSceneListResponse>;

export const DemoSceneResponse = z.object({ scene: ResolvedDemoScene }).strict();
export type DemoSceneResponse = z.infer<typeof DemoSceneResponse>;

export function demoSceneByKey(scenes: readonly DemoScene[], key: string): DemoScene | null {
  return scenes.find((scene) => scene.key === key) ?? null;
}
