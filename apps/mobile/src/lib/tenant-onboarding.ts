import { ApiError } from "@weave-order/core";

/** 只把明确的 NO_MEMBERSHIP 导向创建公司；网络与服务异常交给启动页重试。 */
export async function needsTenantOnboarding(me: () => Promise<unknown>): Promise<boolean> {
  try {
    await me();
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.code === "NO_MEMBERSHIP") return true;
    throw error;
  }
}
