import { eq } from "drizzle-orm";
import { tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  DEFAULT_MEASURE_UNITS,
  MeasureUnits,
  UpdateMeasureUnitsInput,
  hasCapability,
} from "@weave-order/schema";
import type { JsonValue } from "@weave-order/schema";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";

/** 租户设置里的键。 */
const MEASURE_UNITS_SETTING = "measureUnits";

function jsonObject(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

/**
 * 租户默认度量单位（克重 / 门幅）。
 *
 * 只作用于**之后的录入默认值**：新建/编辑样品时单位下拉默认选中它。
 * 改公司默认值不会回头改已经录好的样品 —— 每条样品自带单位与数值，
 * 这正是「单位受控 + 数值独立」带来的好处：换默认值不产生历史数据歧义。
 *
 * 配置落在 `tenants.settings.measureUnits`，和 `salesContact` 同一份租户设置。
 */
export class MeasureUnitsService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  private requireSettingsEdit(ctx: KernelContext): void {
    if (!ctx.actor.role || !hasCapability(ctx.actor.role, "settings.edit")) {
      throw new KernelError("PERMISSION_DENIED", "当前角色不能修改公司设置");
    }
  }

  /**
   * 当前默认单位；没配置过就给行业默认（g/m² 与 cm）。
   *
   * 读不设权限门槛：录入面人人都要用（业务员录样品也要知道默认单位），
   * 这不是敏感信息。写才要 `settings.edit`。
   */
  async get(_ctx: KernelContext): Promise<MeasureUnits> {
    const rows = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, this.tenantId))
      .limit(1);
    const settings = jsonObject(rows[0]?.settings ?? null) ?? {};
    const raw = settings[MEASURE_UNITS_SETTING];
    const parsed = MeasureUnits.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_MEASURE_UNITS;
  }

  /**
   * 改默认单位。
   *
   * 只合并 `measureUnits` 这一个键，不碰其它租户设置；写入前先锁住租户行，
   * 避免两个人同时改互相覆盖。没提交的键保持原值。
   */
  async update(input: unknown, ctx: KernelContext): Promise<MeasureUnits> {
    const parsed = UpdateMeasureUnitsInput.parse(input);
    this.requireSettingsEdit(ctx);
    const before = await this.get(ctx);
    const next: MeasureUnits = {
      weight: parsed.weight ?? before.weight,
      width: parsed.width ?? before.width,
    };
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, this.tenantId))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", "租户不存在", {
          resourceType: "tenant",
          resourceId: this.tenantId,
        });
      }
      const current = jsonObject(row.settings) ?? {};
      await tx
        .update(tenants)
        .set({
          settings: { ...current, [MEASURE_UNITS_SETTING]: next },
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, this.tenantId));
      await appendAudit(
        tx,
        ctx,
        {
          action: "TENANT_MEASURE_UNITS_UPDATED",
          entityType: "tenant",
          entityId: this.tenantId,
          before,
          after: next,
        },
        this.tenantId,
      );
    });
    return next;
  }
}
