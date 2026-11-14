import { defineConfig } from "vitest/config";

/**
 * API 测试配置。
 *
 * 只覆盖一件事：`hookTimeout`。整套集成测试并行跑时（几十个文件各开一条 PG 连接池），
 * afterAll 里的清理 DELETE 偶尔要排队超过默认 10s，会让「用例全绿但套件失败」——
 * 那是最伤人的假红灯。单个用例的超时仍由各文件自己声明，不在这里放宽。
 */
export default defineConfig({
  test: {
    hookTimeout: 30_000,
  },
});
