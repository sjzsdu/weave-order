import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DemoSceneFile, isProductionLike } from "@weave-order/schema";
import type { ApprovalItem, DemoScene } from "@weave-order/schema";

/**
 * 剧本文件的唯一加载入口。
 *
 * 同一份 `data/demo-scenes.json` 被销售（深链）、e2e（断言）与本服务（解析）共用。
 * 文件在仓库根而不是 app 目录，因为它是产品剧本而不是某个进程的配置；
 * 这里从 `__dirname` 向上找到带该文件的目录，开发（src）与构建（dist）路径都能命中。
 */
const SCENES_FILE = "data/demo-scenes.json";

/**
 * 剧本接口是否装配：
 * - 本地 dev（非生产态）→ 装配；
 * - 测试环境（生产态 + WEAVE_ENV=test）→ 装配；
 * - 生产 → 不装配，路由 404，镜像里也没有可点击的演示入口。
 */
export function demoScenesEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionLike(source) || source.WEAVE_ENV === "test";
}

let cached: readonly DemoScene[] | null = null;

export function findRepoRoot(start = __dirname): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, SCENES_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`找不到剧本文件 ${SCENES_FILE}（从 ${start} 向上查找）`);
}

export function loadDemoScenes(file?: string): readonly DemoScene[] {
  if (cached && !file) return cached;
  const target = file ?? path.join(findRepoRoot(), SCENES_FILE);
  const parsed = DemoSceneFile.parse(JSON.parse(readFileSync(target, "utf8")));
  const keys = new Set<string>();
  for (const scene of parsed.scenes) {
    if (keys.has(scene.key)) throw new Error(`剧本 key 重复：${scene.key}`);
    keys.add(scene.key);
  }
  if (!file) cached = parsed.scenes;
  return parsed.scenes;
}

/**
 * 把剧本锚点解析成当前库里的真实单据 id。
 *
 * 不按 id 存剧本：重置后 uuid 会变。按「客户编号 + 单据类型」查审批队列里
 * 最早的一张待办，既稳定（seed 每轮只造一张）又与测试断言口径一致。
 */
export function resolveSceneFromQueue(
  scene: DemoScene,
  customerId: string | null,
  items: readonly ApprovalItem[],
): { entityId: string | null } {
  if (!customerId) return { entityId: null };
  const matches = items
    .filter((item) => item.kind === scene.anchor.kind && item.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { entityId: matches[0]?.id ?? null };
}
