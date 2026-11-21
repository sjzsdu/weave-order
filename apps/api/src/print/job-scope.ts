import { printJobs } from "@weave-order/db";
import { eq } from "drizzle-orm";

/**
 * 正式打印任务的条件。
 *
 * 试打（`is_test = true`）会真的进队列出纸，但不算业务记录：打印抽屉的补打入口、
 * 打印中心队列、打印日志、版本用量、补打前置统计都不该看到它。
 * 把条件收成一个常量，新增查询时直接引用，避免再漏一次 `is_test = false`。
 */
export const OFFICIAL_PRINT_JOB = eq(printJobs.isTest, false);
