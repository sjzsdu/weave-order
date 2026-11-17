import {
  boolean,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { OnboardingStepKey } from "@weave-order/schema";

/**
 * 开张清单进度：一间公司里**每个成员**一行。
 *
 * 为什么按 member 而不是按 tenant：引导是「这个人第一次用」的状态，
 * 老板跳过清单不应该让新来的同事也看不到引导。
 *
 * 为什么落库：issue 要求换设备进度一致；localStorage 只能覆盖一台浏览器。
 * 已有的「哪几步完成」仍由业务事实派生，这里只存服务器观察到的首次完成时间
 * 与收起/跳过偏好，避免出现两份互相矛盾的进度。
 */
export const onboardingState = pgTable(
  "onboarding_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /**
     * 成员键：生产是 `memberships.id`；本地演示没有成员记录时回落成 actor id。
     * 因此用 varchar 而不是 uuid —— 引导进度不是业务单据，不需要外键约束。
     */
    memberId: varchar("member_id", { length: 128 }).notNull(),
    collapsed: boolean("collapsed").notNull().default(false),
    skipped: boolean("skipped").notNull().default(false),
    /** 首次观察到某步完成的时间（ISO），不编造未完成步骤的历史。 */
    completedAt: jsonb("completed_at")
      .$type<Partial<Record<OnboardingStepKey, string>>>()
      .notNull()
      .default({}),
    /** 四步全部完成的时间；未全部完成为 null。 */
    allDoneAt: timestamp("all_done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 一个人在一个租户只有一行；并发上报靠它收敛，不需要应用层加锁。
    uniqueIndex("onboarding_state_tenant_member_idx").on(table.tenantId, table.memberId),
  ],
);
