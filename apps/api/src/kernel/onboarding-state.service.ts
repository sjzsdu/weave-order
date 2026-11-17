import { onboardingState } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  OnboardingState,
  UpdateOnboardingStateInput,
  ONBOARDING_STEP_KEYS,
} from "@weave-order/schema";
import type {
  OnboardingState as OnboardingStateType,
  OnboardingStepKey,
  UpdateOnboardingStateInput as UpdateInput,
} from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
import { toIso, toIsoOrNull } from "./mappers";

type Row = typeof onboardingState.$inferSelect;

/**
 * 开张清单进度（每个成员一行）。
 *
 * 两条边界：
 * - 「哪几步完成」由业务事实派生（客户/样品/报价/已批单数量），这里只记
 *   **服务器第一次观察到完成的时间**，客户端不能自报时间戳；
 * - 收起 / 跳过是用户偏好，落库是为了换设备一致，不是业务账本，
 *   所以不写 audit（审计只记「谁改了业务事实」）。
 */
export class OnboardingStateService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async get(memberId: string): Promise<OnboardingStateType> {
    const [row] = await this.db
      .select()
      .from(onboardingState)
      .where(
        and(eq(onboardingState.tenantId, this.tenantId), eq(onboardingState.memberId, memberId)),
      )
      .limit(1);
    return row ? mapRow(row) : emptyState();
  }

  async update(memberId: string, rawInput: unknown): Promise<OnboardingStateType> {
    const input: UpdateInput = UpdateOnboardingStateInput.parse(rawInput);
    const now = new Date();
    const current = await this.get(memberId);

    // 只补新完成的步骤：重复上报同一键不覆盖首次时间。
    const completedAt = { ...current.completedAt };
    for (const step of input.completeSteps ?? []) {
      if (!completedAt[step]) completedAt[step] = toIso(now);
    }
    const allDone =
      current.allDoneAt !== null ||
      ONBOARDING_STEP_KEYS.every((step: OnboardingStepKey) => completedAt[step] !== undefined);

    const [row] = await this.db
      .insert(onboardingState)
      .values({
        tenantId: this.tenantId,
        memberId,
        collapsed: input.collapsed ?? current.collapsed,
        skipped: input.skipped ?? current.skipped,
        completedAt,
        allDoneAt: allDone ? (current.allDoneAt ? new Date(current.allDoneAt) : now) : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [onboardingState.tenantId, onboardingState.memberId],
        set: {
          collapsed: input.collapsed ?? current.collapsed,
          skipped: input.skipped ?? current.skipped,
          completedAt,
          allDoneAt: allDone ? (current.allDoneAt ? new Date(current.allDoneAt) : now) : null,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) {
      // 并发下 returning 为空只可能是同一行被删；重读一次比抛 500 更贴近事实。
      return this.get(memberId);
    }
    return mapRow(row);
  }
}

function mapRow(row: Row): OnboardingStateType {
  return OnboardingState.parse({
    completedAt: row.completedAt ?? {},
    collapsed: row.collapsed,
    skipped: row.skipped,
    allDoneAt: toIsoOrNull(row.allDoneAt),
    updatedAt: toIso(row.updatedAt),
  });
}

function emptyState(): OnboardingStateType {
  return { completedAt: {}, collapsed: false, skipped: false, allDoneAt: null, updatedAt: null };
}
