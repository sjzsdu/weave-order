import { ensureSeed } from "./seed";

/**
 * 只做「机器能替的准备」：等 API / 对象存储就绪、写入幂等种子、等后台索引完成。
 * 服务进程由 playwright.config.ts 的 webServer 拉起。
 */
export default async function globalSetup(): Promise<void> {
  const startedAt = Date.now();
  const manifest = await ensureSeed();
  console.log(
    `[e2e] 种子就绪：${manifest.fabricSamples.length} 个共用图样品 + 1 个双图样品（${Date.now() - startedAt}ms）`,
  );
}
