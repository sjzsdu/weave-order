import {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalQueue,
  PanoramaSnapshot,
  PanoramaStats,
} from "@weave-order/schema";
import type {
  ApprovalDecisionResult as DecisionResult,
  ApprovalItem,
  PanoramaSnapshot as Panorama,
  ToolError,
  ZodIssueSummary,
} from "@weave-order/schema";
import { isKernelError } from "../kernel";
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
    /** 审批队列：从账本读出所有 DRAFT 单据（报价 + 寄样），纯只读聚合。 */
    async listPending(): Promise<ApprovalQueue> {
      const [quotes, shipments] = await Promise.all([
        kernel.quotes.list(100),
        kernel.shipments.list(100),
      ]);
      const items = [...quotes, ...shipments]
        .filter((entry) => entry.pending)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ApprovalQueue.parse({ items });
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
    async panorama(): Promise<Panorama> {
      const [customers, samples, quotes, shipments, audit] = await Promise.all([
        kernel.customers.list(100),
        kernel.search.listSamples(100),
        kernel.quotes.list(100),
        kernel.shipments.list(100),
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

export type ApprovalService = ReturnType<typeof createApprovalService>;
