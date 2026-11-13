import {
  ApprovalDetail,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  PanoramaSnapshot,
  PanoramaStats,
} from "@weave-order/schema";
import type {
  ApprovalDetail as Detail,
  ApprovalDecisionResult as DecisionResult,
  ApprovalItem,
  ApprovalKind,
  PanoramaSnapshot as Panorama,
  ToolError,
  ZodIssueSummary,
} from "@weave-order/schema";
import { formatMoney, isKernelError, mayViewCost } from "../kernel";
import type { Kernel, KernelContext } from "../kernel";

/**
 * 审批服务（审批窗口的服务端核心）。
 *
 * 目录边界：和 tools 一样只依赖 Kernel 的公开方法，禁止直连数据库（ESLint 锁定）。
 * 铁律 #2：批准 / 拒绝都必须由人类触发 —— 控制器传入 HUMAN 上下文，内核的
 * confirm / reject 还会再校验 actor.type === "HUMAN" 兜底，智能体无法绕过。
 *
 * 前端只拿到「只读视图」与「决策回执」；真正 DRAFT -> 生效 / 驳回的落账
 * 全部发生在内核的同一事务里，approval 服务自己不写任何业务表。
 */

interface ZodIssueLike {
  path?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * 用形状判定 ZodError 的 issues，而非 `instanceof ZodError`：
 * 契约包经 dist 加载、api 直接引用 zod，在 vitest 的模块图里可能拿到两份实例，
 * instanceof 会失效；这里按公开的 issues 数组提取，跨实例同样稳定。
 */
function zodIssues(error: unknown): ZodIssueSummary[] | null {
  if (typeof error !== "object" || error === null || !("issues" in error)) return null;
  const raw: unknown = error.issues;
  if (!Array.isArray(raw)) return null;
  return raw.map((entry: unknown): ZodIssueSummary => {
    const issue = (entry ?? {}) as ZodIssueLike;
    const pathValue: unknown = issue.path;
    return {
      path: Array.isArray(pathValue)
        ? pathValue.map((segment: unknown): string | number =>
            typeof segment === "number" || typeof segment === "string" ? segment : "",
          )
        : [],
      code: typeof issue.code === "string" ? issue.code : "invalid",
      message: typeof issue.message === "string" ? issue.message : "",
    };
  });
}

/** 把 Zod / 内核 / 未知异常统一收敛到封闭的 ToolError 集合，不另起失败语义。 */
function approvalError(error: unknown): ToolError {
  const issues = zodIssues(error);
  if (issues) {
    return { code: "INVALID_INPUT", message: "审批决策入参未通过 Schema 校验", issues };
  }
  if (isKernelError(error)) return error.toToolError();
  return { code: "INTERNAL", message: error instanceof Error ? error.message : "未知错误" };
}

function failure(error: unknown): DecisionResult {
  return ApprovalDecisionResult.parse({ ok: false, error: approvalError(error) });
}

export function createApprovalService(kernel: Kernel) {
  return {
    /** 审批队列：从账本读出可见范围内的 DRAFT 单据（报价 + 寄样），纯只读聚合。 */
    async listPending(ctx?: KernelContext): Promise<ApprovalQueue> {
      const [quotes, shipments] = await Promise.all([
        kernel.quotes.list(100, ctx),
        kernel.shipments.list(100, ctx),
      ]);
      const items = [...quotes, ...shipments]
        .filter((entry) => entry.pending)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ApprovalQueue.parse({ items });
    },

    /**
     * 审批卡详情：出处 / 生效值 / diff 一次聚合。
     * 只读，不落账；金额与风险全部由后端给出，前端只展示。
     */
    async detail(id: string, kind: ApprovalKind, ctx?: KernelContext): Promise<Detail | null> {
      const [quotes, shipments] = await Promise.all([
        kernel.quotes.list(100, ctx),
        kernel.shipments.list(100, ctx),
      ]);
      const item = [...quotes, ...shipments].find(
        (entry) => entry.id === id && entry.kind === kind,
      );
      if (!item) return null;

      const [customer, audit] = await Promise.all([
        kernel.customers.getById(item.customerId, ctx).catch(() => null),
        kernel.audit.list(20),
      ]);

      if (kind === "quote") {
        const view = await kernel.quotes.getApprovalView(id, ctx).catch(() => null);
        if (!view) return null;

        // 成本底线属于敏感字段：sales 等角色看不到具体数字，但单据本身照常可审。
        const showCost = mayViewCost(ctx?.actor.role);
        const provenance: Detail["provenance"] = view.items.flatMap((line) => {
          const raw = jsonRecord(line.provenance);
          const sample = jsonRecord(raw.sample);
          const unitPrice = jsonRecord(raw.unitPrice);
          const entries: Detail["provenance"] = [
            {
              id: `line-${line.lineIndex}-kernel`,
              kind: "AGENT",
              label: `第 ${line.lineIndex + 1} 行单价`,
              value: formatMoney(line.unitPrice),
              detail: "内核按整数分重算：单价 × 数量，智能体不得直接填写总额。",
              sourceRef: null,
            },
          ];
          if (typeof sample.code === "string") {
            const costFloor = jsonRecord(sample.costFloor);
            entries.push({
              id: `line-${line.lineIndex}-sample`,
              kind: "COST",
              label: "样品 / 成本底线",
              value:
                showCost && typeof costFloor.amount === "number"
                  ? `${String(sample.code)} · ${formatMoney({
                      amount: costFloor.amount,
                      currency: view.currency,
                    })}`
                  : String(sample.code),
              detail: typeof sample.name === "string" ? sample.name : null,
              sourceRef: null,
            });
          }
          if (typeof unitPrice.source === "string") {
            entries.push({
              id: `line-${line.lineIndex}-pricing`,
              kind: "POLICY",
              label: "定价来源",
              value: unitPrice.source,
              detail:
                showCost && typeof unitPrice.floorCents === "number"
                  ? `成本/毛利底线 ${formatMoney({ amount: unitPrice.floorCents, currency: view.currency })}`
                  : null,
              sourceRef: null,
            });
          }
          return entries;
        });

        for (const policy of view.requirement.policySources) {
          provenance.push({
            id: `policy-${policy.key}`,
            kind: "POLICY",
            label: `阈值 ${policy.key}`,
            value: truncate(JSON.stringify(policy.value), 120),
            detail: `来源：${sourceLabel(policy.source)}${policy.clamped ? "（下级放宽被管控夹取）" : ""}`,
            sourceRef: null,
          });
        }

        provenance.push({
          id: "customer-tier",
          kind: "CUSTOMER",
          label: "客户背景",
          value: customer ? `${customer.name} · ${customer.tier}` : "客户信息不可见",
          detail: customer ? `客户编号 ${customer.code}` : null,
          sourceRef: null,
        });

        // 风险等级只跟随后端 resolved policy / 升级结果，不在前端另设阈值。
        const escalated = view.requirement.escalated;
        return ApprovalDetail.parse({
          item,
          customer,
          draft: {
            state: item.pending ? "DRAFT" : "CONFIRMED",
            version: view.version,
            revisedByHuman: view.revisions.some((revision) => revision.actorType === "HUMAN"),
            revisionCount: view.revisions.length,
          },
          lines: view.items.map((line) => ({
            id: `${view.quoteId}-${line.lineIndex}`,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
          subtotal: view.subtotal,
          total: view.total,
          currency: view.currency,
          provenance,
          diffs: view.diff,
          missingFields:
            view.status === "DRAFT"
              ? [
                  {
                    field: "remarks",
                    label: "报价备注",
                    hint: "补充交期或付款条件会更完整",
                  },
                ]
              : [],
          risk: {
            level:
              escalated && view.requirement.level === "OWNER"
                ? "HIGH"
                : escalated
                  ? "MEDIUM"
                  : "LOW",
            reasons: view.requirement.reasons,
          },
          audit,
        });
      }

      const shipment = await kernel.shipments.getById(id).catch(() => null);
      if (!shipment) return null;
      return ApprovalDetail.parse({
        item,
        customer,
        draft: {
          state: item.pending ? "DRAFT" : "CONFIRMED",
          version: 1,
          revisedByHuman: false,
          revisionCount: 0,
        },
        lines: [],
        subtotal: null,
        total: null,
        currency: item.currency ?? "CNY",
        provenance: [
          {
            id: "shipment-channel",
            kind: "AGENT",
            label: "寄样方式",
            value: shipment.channel,
            detail: shipment.note ?? "智能体按客户历史偏好建议的寄样方式。",
            sourceRef: null,
          },
        ],
        diffs: [],
        missingFields: shipment.trackingNumber
          ? []
          : [
              {
                field: "trackingNumber",
                label: "运单号",
                hint: "补一下就能继续跟踪",
              },
            ],
        risk: { level: "LOW", reasons: [] },
        audit,
      });
    },

    /** 批准 / 拒绝：唯一的人类决策入口，内部落到内核 confirm / reject。 */
    async decide(input: unknown, ctx: KernelContext): Promise<DecisionResult> {
      const parsed = ApprovalDecisionInput.safeParse(input);
      if (!parsed.success) return failure(parsed.error);

      const { id, kind, decision, note, reasonId, baseVersion } = parsed.data;
      try {
        let status: ApprovalItem["status"];
        if (kind === "quote") {
          if (decision === "APPROVE") {
            status =
              baseVersion === undefined
                ? (await kernel.quotes.confirmDraft(id, ctx)).status
                : (await kernel.quotes.confirmDraft(id, ctx, baseVersion)).status;
          } else {
            status =
              reasonId === undefined
                ? (await kernel.quotes.rejectDraft(id, ctx, note)).status
                : (await kernel.quotes.rejectDraft(id, ctx, note, reasonId)).status;
          }
        } else if (decision === "APPROVE") {
          status = (await kernel.shipments.confirm(id, ctx)).status;
        } else {
          status = (await kernel.shipments.reject(id, ctx, note)).status;
        }

        return ApprovalDecisionResult.parse({
          ok: true,
          data: {
            id,
            kind,
            decision,
            status,
            actorType: "HUMAN",
            decidedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        return failure(error);
      }
    },

    /** 业务全景（只读）：一次拉取，前端纯展示。 */
    async panorama(ctx?: KernelContext): Promise<Panorama> {
      const [customers, samples, quotes, shipments, audit] = await Promise.all([
        kernel.customers.list(100, ctx),
        kernel.search.listSamples(100, ctx),
        kernel.quotes.list(100, ctx),
        kernel.shipments.list(100, ctx),
        kernel.audit.list(20),
      ]);
      const items = [...quotes, ...shipments].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const stats = PanoramaStats.parse({
        customerCount: customers.length,
        sampleCount: samples.length,
        quoteCount: quotes.length,
        shipmentCount: shipments.length,
        pendingCount: items.filter((entry) => entry.pending).length,
        sentQuoteCount: quotes.filter((entry) => entry.status === "SENT").length,
        confirmedShipmentCount: shipments.filter((entry) => entry.status === "CONFIRMED").length,
        rejectedCount: items.filter(
          (entry) => entry.status === "REJECTED" || entry.status === "CANCELLED",
        ).length,
        auditCount: audit.length,
      });
      return PanoramaSnapshot.parse({
        generatedAt: new Date().toISOString(),
        customers,
        samples,
        items,
        audit,
        stats,
      });
    },
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sourceLabel(source: unknown): string {
  const record = jsonRecord(source);
  const scope = typeof record.scopeType === "string" ? record.scopeType : "UNKNOWN";
  const policyId = typeof record.policyId === "string" ? record.policyId : null;
  return policyId ? `${scope} · ${policyId}` : scope;
}

export type ApprovalService = ReturnType<typeof createApprovalService>;
