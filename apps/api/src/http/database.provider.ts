/**
 * 兼容导出：连接提供者已上移到 platform（网关与 HTTP 共用）。
 * 保留此文件避免既有 import 路径断裂；边界规则仍只放开 platform 连接句柄。
 */
export { DatabaseProvider } from "../platform/database.provider";
